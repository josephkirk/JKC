use jkc_lib::db::{Database, LibraryQuery};
use jkc_lib::media::MediaProcessor;
use std::io::Write;
use tempfile::tempdir;

#[test]
fn test_hashing_differs_after_64kb() {
    let dir = tempdir().unwrap();
    let file_a_path = dir.path().join("file_a.bin");
    let file_b_path = dir.path().join("file_b.bin");

    // 128 KiB files
    let mut data_a = vec![0x42u8; 128 * 1024];
    let mut data_b = vec![0x42u8; 128 * 1024];

    // Alter byte at 70,000 (well past 64 KiB)
    data_b[70_000] = 0x99;

    {
        let mut fa = std::fs::File::create(&file_a_path).unwrap();
        fa.write_all(&data_a).unwrap();
    }
    {
        let mut fb = std::fs::File::create(&file_b_path).unwrap();
        fb.write_all(&data_b).unwrap();
    }

    let processor = MediaProcessor::new(dir.path()).unwrap();
    let hash_a = processor.compute_file_hash(&file_a_path).unwrap();
    let hash_b = processor.compute_file_hash(&file_b_path).unwrap();

    assert_ne!(hash_a, hash_b, "Hashes must differ when files differ past 64 KiB");
}

#[test]
fn test_db_migration_and_media_upsert() {
    let dir = tempdir().unwrap();
    let db_path = dir.path().join("test_jkc.sqlite3");
    let db = Database::new(&db_path).unwrap();

    // Add root
    let root_path_str = dir.path().to_string_lossy().to_string();
    let root = db.add_root(&root_path_str).unwrap();

    let sample_file = dir.path().join("photo.png");
    std::fs::write(&sample_file, b"test image").unwrap();
    let sample_str = sample_file.canonicalize().unwrap().to_string_lossy().to_string();

    let item = db.upsert_media(
        &root.id,
        &sample_str,
        "image",
        "photo.png",
        1000,
        1700000000,
        Some("hash123"),
    ).unwrap();

    assert_eq!(item.name, "photo.png");
    assert_eq!(item.content_hash, Some("hash123".to_string()));
    assert_eq!(item.size_bytes, 1000);

    // Update metadata
    db.update_media_metadata(&item.id, Some(1920), Some(1080), Some(4000)).unwrap();

    let loaded = db.get_media(&item.id).unwrap();
    assert_eq!(loaded.width, Some(1920));
    assert_eq!(loaded.height, Some(1080));
    assert_eq!(loaded.duration_ms, Some(4000));
}

#[test]
fn test_tag_case_insensitivity_and_search() {
    let dir = tempdir().unwrap();
    let db_path = dir.path().join("test_tags.sqlite3");
    let db = Database::new(&db_path).unwrap();

    let root = db.add_root(&dir.path().to_string_lossy()).unwrap();
    let file = dir.path().join("video.mp4");
    std::fs::write(&file, b"video data").unwrap();
    let file_str = file.canonicalize().unwrap().to_string_lossy().to_string();

    let item = db.upsert_media(&root.id, &file_str, "video", "video.mp4", 500, 100, Some("h")).unwrap();

    // Set mixed case tag
    db.set_media_tags(&item.id, &[ "Action".to_string(), "Sci-Fi".to_string() ]).unwrap();

    // Query with lowercase tag
    let q = LibraryQuery {
        root_id: None,
        search: None,
        kind: None,
        favorite_only: None,
        tag: Some("action".to_string()),
        page: None,
        page_size: None,
    };
    let res = db.query_media(&q).unwrap();
    assert_eq!(res.total, 1);
    assert_eq!(res.items[0].id, item.id);

    // All tags query
    let all_tags = db.get_all_tags().unwrap();
    assert_eq!(all_tags.len(), 2);
}

#[test]
fn test_root_containment_logic() {
    let dir = tempdir().unwrap();
    let sub = dir.path().join("allowed_sub");
    std::fs::create_dir(&sub).unwrap();

    let inside_file = sub.join("inside.txt");
    std::fs::write(&inside_file, b"inside").unwrap();

    let outside_file = dir.path().join("outside.txt");
    std::fs::write(&outside_file, b"outside").unwrap();

    let canon_root = sub.canonicalize().unwrap();
    let canon_inside = inside_file.canonicalize().unwrap();
    let canon_outside = outside_file.canonicalize().unwrap();

    assert!(canon_inside.starts_with(&canon_root));
    assert!(!canon_outside.starts_with(&canon_root));
}

#[test]
fn test_failed_export_preserves_old_output() {
    let dir = tempdir().unwrap();
    let target = dir.path().join("existing.mp4");
    std::fs::write(&target, b"original content").unwrap();

    // Corrupt input
    let corrupt_input = dir.path().join("corrupt.mp4");
    std::fs::write(&corrupt_input, b"not a real video").unwrap();

    let processor = MediaProcessor::new(dir.path()).unwrap();
    let res = processor.capture_still(&corrupt_input, 1000, &target);
    assert!(res.is_err());

    // Verify original content was preserved!
    let content = std::fs::read(&target).unwrap();
    assert_eq!(content, b"original content");
}

#[test]
fn test_board_document_persistence_roundtrip() {
    let dir = tempdir().unwrap();
    let db_path = dir.path().join("test_board.sqlite3");
    let db = Database::new(&db_path).unwrap();

    let board_id = "board_123";
    let board_json = r##"{"version":1,"id":"board_123","name":"Moodboard","viewport":{"x":100.5,"y":-50.0,"scale":1.25},"items":[{"id":"item1","type":"note","x":10,"y":20,"width":200,"height":150,"rotation":0,"zIndex":1,"text":"Inspiration","color":"#fef08a"}]}"##;

    db.save_board(board_id, "Moodboard", board_json).unwrap();

    let loaded = db.get_board(board_id).unwrap().expect("Board should exist");
    assert!(loaded.contains("Moodboard"));
    assert!(loaded.contains("1.25"));
    assert!(loaded.contains("Inspiration"));

    let list = db.list_boards().unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].id, board_id);
    assert_eq!(list[0].item_count, 1);
}

#[test]
fn test_atomic_replace_overwrites_existing_file_on_windows() {
    let dir = tempdir().unwrap();
    let target = dir.path().join("layer_abc123.png");

    // First save
    let tmp1 = dir.path().join("tmp1.png");
    std::fs::write(&tmp1, b"first version").unwrap();
    jkc_lib::media::atomic_replace(&tmp1, &target).unwrap();
    assert_eq!(std::fs::read(&target).unwrap(), b"first version");

    // Second save (updating same existing asset)
    let tmp2 = dir.path().join("tmp2.png");
    std::fs::write(&tmp2, b"second updated version").unwrap();
    jkc_lib::media::atomic_replace(&tmp2, &target).unwrap();
    assert_eq!(std::fs::read(&target).unwrap(), b"second updated version");
}

#[test]
fn test_shot_detection_and_red_pixel_still_capture() {
    let dir = tempdir().unwrap();
    let fixture_video = std::path::Path::new("../target/test_fixtures/two_color_cut_4s.mp4");
    if !fixture_video.exists() {
        return; // Test fixtures not generated in this path
    }

    let processor = MediaProcessor::new(dir.path()).unwrap();

    // 1. Shot detection
    let boundaries = processor.detect_shots(fixture_video, 4000).unwrap();
    assert!(boundaries.len() >= 2, "Must detect boundaries");
    assert_eq!(boundaries[0], 0);

    // Boundary should be near 2000 ms (within 2 frames at 30fps = ~67ms)
    let mid_boundary = boundaries.iter().find(|&&b| b >= 1933 && b <= 2067);
    assert!(mid_boundary.is_some(), "Must detect red/blue cut near 2000ms: {:?}", boundaries);

    // 2. Still capture at 1000ms (red)
    let still_red = dir.path().join("still_red.png");
    processor.capture_still(fixture_video, 1000, &still_red).unwrap();
    assert!(still_red.exists());

    let img_red = image::open(&still_red).unwrap();
    let px_red = img_red.to_rgba8().get_pixel(160, 120).clone();
    assert!(px_red[0] > 180 && px_red[1] < 60 && px_red[2] < 60, "Frame at 1s must be red, got: {:?}", px_red);

    // 3. Still capture at 3000ms (blue)
    let still_blue = dir.path().join("still_blue.png");
    processor.capture_still(fixture_video, 3000, &still_blue).unwrap();
    assert!(still_blue.exists());

    let img_blue = image::open(&still_blue).unwrap();
    let px_blue = img_blue.to_rgba8().get_pixel(160, 120).clone();
    assert!(px_blue[2] > 180 && px_blue[0] < 60 && px_blue[1] < 60, "Frame at 3s must be blue, got: {:?}", px_blue);
}

#[test]
fn test_relink_preserves_reviews_and_metadata() {
    let dir = tempdir().unwrap();
    let db_path = dir.path().join("test_relink.sqlite3");
    let db = Database::new(&db_path).unwrap();

    let root = db.add_root(&dir.path().to_string_lossy()).unwrap();
    let file_a = dir.path().join("file_a.png");
    std::fs::write(&file_a, b"file content a").unwrap();
    let file_a_str = file_a.canonicalize().unwrap().to_string_lossy().to_string();

    let item = db.upsert_media(&root.id, &file_a_str, "image", "file_a.png", 100, 1000, Some("h1")).unwrap();

    // Add review
    let review_doc = r#"{"version":1,"mediaId":"item1","comments":[{"id":"c1","timeMs":1000,"text":"Great frame","createdAt":1000}],"takes":[],"shotBoundariesMs":[],"annotations":[]}"#;
    db.save_review(&item.id, review_doc).unwrap();

    // Move file externally
    let file_b = dir.path().join("file_b_moved.png");
    std::fs::rename(&file_a, &file_b).unwrap();

    // Rescan marks missing
    db.mark_media_missing_in_root(&root.id, &[]).unwrap();
    let missing_item = db.get_media(&item.id).unwrap();
    assert!(missing_item.missing);

    // Review remains preserved in database
    let loaded_review = db.get_review(&item.id).unwrap().expect("Review should survive missing file");
    assert!(loaded_review.contains("Great frame"));

    // Relink to new path
    let relinked = db.relink_media(&item.id, &file_b.to_string_lossy(), None).unwrap();
    assert!(!relinked.missing);
    assert_eq!(relinked.name, "file_b_moved.png");

    // Review still attached!
    let review_after_relink = db.get_review(&item.id).unwrap().unwrap();
    assert!(review_after_relink.contains("Great frame"));
}

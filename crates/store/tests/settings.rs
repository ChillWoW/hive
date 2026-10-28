use std::fs;

use hive_proto::Settings;
use hive_store::{SettingsFile, SETTINGS_FILE};
use serde_json::json;

#[test]
fn creates_defaults_and_ignores_no_op_updates() {
    let dir = tempfile::tempdir().unwrap();
    let file = SettingsFile::open(dir.path()).unwrap();
    assert_eq!(file.get(), Settings::default());
    assert!(dir.path().join(SETTINGS_FILE).exists());

    let (s, changed) = file.update(&json!({ "unknown": true })).unwrap();
    assert!(!changed);
    assert_eq!(s, Settings::default());

    let reopened = SettingsFile::open(dir.path()).unwrap();
    assert_eq!(reopened.get(), Settings::default());
}

#[test]
fn backs_up_unreadable_file() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join(SETTINGS_FILE), "{ not json").unwrap();
    let file = SettingsFile::open(dir.path()).unwrap();
    assert_eq!(file.get(), Settings::default());
    assert_eq!(
        fs::read_to_string(dir.path().join("settings.json.bak")).unwrap(),
        "{ not json"
    );
}

#[test]
fn open_rewrites_a_file_that_needed_sanitizing() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(SETTINGS_FILE);
    fs::write(&path, r#"{ "version": 99, "stale": 1 }"#).unwrap();
    SettingsFile::open(dir.path()).unwrap();
    let on_disk: Settings = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(on_disk, Settings::default());
    assert!(!fs::read_to_string(&path).unwrap().contains("stale"));
}

#[test]
fn reload_ignores_edits_that_change_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let file = SettingsFile::open(dir.path()).unwrap();
    fs::write(file.path(), r#"{ "unknown": 1 }"#).unwrap();
    let (s, changed) = file.reload().unwrap();
    assert!(!changed);
    assert_eq!(s, Settings::default());
}

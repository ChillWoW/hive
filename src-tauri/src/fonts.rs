//! The font families installed on the system, for the interface font picker.

use std::collections::BTreeMap;

/// Family names, sorted case-insensitively. Hidden (`.SF…`) and vertical
/// CJK (`@MS Gothic`) families are left out.
#[tauri::command]
pub async fn fonts_list() -> Vec<String> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut db = fontdb::Database::new();
        db.load_system_fonts();
        let mut families = BTreeMap::new();
        for face in db.faces() {
            let Some((name, _)) = face.families.first() else {
                continue;
            };
            let name = name.trim();
            if name.is_empty() || name.starts_with(['.', '@']) {
                continue;
            }
            families
                .entry(name.to_lowercase())
                .or_insert_with(|| name.to_owned());
        }
        families.into_values().collect()
    })
    .await
    .unwrap_or_default()
}

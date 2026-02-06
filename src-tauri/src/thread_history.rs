use serde_json::{json, Value};
use std::path::PathBuf;
use tauri::State;

use crate::state::AppState;

const THREAD_HISTORY_DIR: &str = "threads";

fn history_dir(state: &AppState) -> PathBuf {
    state
        .storage_path
        .parent()
        .map(|parent| parent.join(THREAD_HISTORY_DIR))
        .unwrap_or_else(|| PathBuf::from(THREAD_HISTORY_DIR))
}

fn history_path(state: &AppState, workspace_id: &str) -> PathBuf {
    history_dir(state).join(format!("{workspace_id}.json"))
}

fn default_history(workspace_id: &str) -> Value {
    json!({
        "version": 1,
        "workspaceId": workspace_id,
        "threads": [],
        "itemsByThread": {},
        "threadParentById": {},
        "activeThreadId": null,
        "savedAt": chrono::Utc::now().timestamp_millis(),
    })
}

#[tauri::command]
pub(crate) async fn thread_history_load(
    workspace_id: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let path = history_path(&state, &workspace_id);
    if !path.exists() {
        return Ok(default_history(&workspace_id));
    }
    let data = std::fs::read_to_string(&path).map_err(|err| err.to_string())?;
    let mut value: Value = serde_json::from_str(&data).map_err(|err| err.to_string())?;
    if let Value::Object(map) = &mut value {
        map.entry("workspaceId".to_string())
            .or_insert_with(|| json!(workspace_id));
        map.entry("version".to_string())
            .or_insert_with(|| json!(1));
    }
    Ok(value)
}

#[tauri::command]
pub(crate) async fn thread_history_save(
    workspace_id: String,
    mut history: Value,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let path = history_path(&state, &workspace_id);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    if let Value::Object(map) = &mut history {
        map.insert("workspaceId".to_string(), json!(workspace_id));
        map.entry("version".to_string())
            .or_insert_with(|| json!(1));
        map.insert(
            "savedAt".to_string(),
            json!(chrono::Utc::now().timestamp_millis()),
        );
    }
    let data = serde_json::to_string_pretty(&history).map_err(|err| err.to_string())?;
    let temp_path = path.with_extension("json.tmp");
    std::fs::write(&temp_path, data).map_err(|err| err.to_string())?;
    std::fs::rename(&temp_path, &path).map_err(|err| err.to_string())
}

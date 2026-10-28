#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod git;

use git::{Branch, Commit, CommitOptions, Repo, RepoEntry, Status};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

type Res<T> = Result<T, String>;

struct AppState {
    repo: Mutex<Option<Repo>>,
    launch_path: Option<String>,
}

fn current(state: &State<AppState>) -> Res<Repo> {
    state
        .repo
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "No repository open".to_string())
}

#[tauri::command]
fn launch_path(state: State<AppState>) -> Option<String> {
    state.launch_path.clone()
}

#[tauri::command(async)]
fn open_repo(state: State<AppState>, path: String) -> Res<String> {
    let repo = Repo::open(&path)?;
    let root = repo.root.clone();
    *state.repo.lock().unwrap() = Some(repo);
    Ok(root)
}

#[tauri::command(async)]
fn pick_repo(app: AppHandle, state: State<AppState>) -> Res<Option<String>> {
    let Some(dir) = app.dialog().file().set_title("Open Git Repository").blocking_pick_folder()
    else {
        return Ok(None);
    };
    let path = dir.into_path().map_err(|e| e.to_string())?;
    open_repo(state, path.to_string_lossy().into_owned()).map(Some)
}

#[tauri::command(async)]
fn discover_repos() -> Vec<RepoEntry> {
    git::discover_repos()
}

#[tauri::command(async)]
fn status(state: State<AppState>) -> Res<Status> {
    current(&state)?.status()
}

#[tauri::command(async)]
fn stage(state: State<AppState>, paths: Vec<String>) -> Res<()> {
    current(&state)?.stage(&paths)
}

#[tauri::command(async)]
fn unstage(state: State<AppState>, paths: Vec<String>) -> Res<()> {
    current(&state)?.unstage(&paths)
}

#[tauri::command(async)]
fn stage_all(state: State<AppState>) -> Res<()> {
    current(&state)?.stage_all()
}

#[tauri::command(async)]
fn unstage_all(state: State<AppState>) -> Res<()> {
    current(&state)?.unstage_all()
}

#[tauri::command(async)]
fn discard(state: State<AppState>, paths: Vec<String>) -> Res<()> {
    current(&state)?.discard(&paths)
}

#[tauri::command(async)]
fn trash(state: State<AppState>, paths: Vec<String>) -> Res<()> {
    current(&state)?.trash(&paths)
}

#[tauri::command(async)]
fn delete_files(state: State<AppState>, paths: Vec<String>) -> Res<()> {
    current(&state)?.delete_files(&paths)
}

#[tauri::command(async)]
fn stash_all(state: State<AppState>) -> Res<()> {
    current(&state)?.stash_all()
}

#[tauri::command(async)]
fn commit(state: State<AppState>, message: String, options: CommitOptions) -> Res<String> {
    current(&state)?.commit(&message, &options)
}

#[tauri::command(async)]
fn stash_pop(state: State<AppState>) -> Res<()> {
    current(&state)?.stash_pop()
}

#[tauri::command(async)]
fn head_message(state: State<AppState>) -> Res<String> {
    current(&state)?.head_message()
}

#[tauri::command(async)]
fn uncommit(state: State<AppState>) -> Res<String> {
    current(&state)?.uncommit()
}

#[tauri::command(async)]
fn head_pushed_to(state: State<AppState>) -> Res<Vec<String>> {
    current(&state)?.head_pushed_to()
}

#[tauri::command(async)]
fn remote(state: State<AppState>, op: String) -> Res<String> {
    current(&state)?.remote(&op)
}

#[tauri::command(async)]
fn log(state: State<AppState>, skip: u32, limit: u32) -> Res<Vec<Commit>> {
    current(&state)?.log(skip, limit)
}

#[tauri::command(async)]
fn diff_file(state: State<AppState>, path: String, untracked: bool) -> Res<String> {
    current(&state)?.diff_file(&path, untracked)
}

#[tauri::command(async)]
fn diff_all(state: State<AppState>) -> Res<String> {
    current(&state)?.diff_all()
}

#[tauri::command(async)]
fn show_commit(state: State<AppState>, hash: String) -> Res<String> {
    current(&state)?.show_commit(&hash)
}

#[tauri::command(async)]
fn generate_commit_message(state: State<AppState>) -> Res<String> {
    current(&state)?.generate_commit_message()
}

#[tauri::command(async)]
fn branches(state: State<AppState>) -> Res<Vec<Branch>> {
    current(&state)?.branches()
}

#[tauri::command(async)]
fn switch_branch(state: State<AppState>, name: String, create: bool) -> Res<()> {
    current(&state)?.switch_branch(&name, create)
}

fn main() {
    let initial = std::env::args().nth(1).or_else(|| {
        std::env::current_dir()
            .ok()
            .map(|p| p.to_string_lossy().into_owned())
    });

    tauri::Builder::default()
        // A second launch (e.g. from the keybinding) hands its target to the
        // running window instead of opening another one.
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            let _ = app.emit("open-path", argv.get(1).cloned().unwrap_or(cwd));
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            repo: Mutex::new(None),
            launch_path: initial,
        })
        .setup(|app| {
            // Initial size: 620px wide, 88% of the monitor's height. After the
            // first resize Hyprland's persistent_size rule takes over.
            if let Some(w) = app.get_webview_window("main") {
                if let Ok(Some(m)) = w.current_monitor() {
                    let height = m.size().height as f64 / m.scale_factor() * 0.88;
                    let _ = w.set_size(tauri::LogicalSize::new(620.0, height.clamp(500.0, 1100.0)));
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            launch_path,
            open_repo,
            pick_repo,
            discover_repos,
            status,
            stage,
            unstage,
            stage_all,
            unstage_all,
            discard,
            trash,
            delete_files,
            stash_all,
            commit,
            uncommit,
            head_pushed_to,
            stash_pop,
            head_message,
            remote,
            log,
            diff_file,
            diff_all,
            show_commit,
            branches,
            generate_commit_message,
            switch_branch,
        ])
        .run(tauri::generate_context!())
        .expect("error while running gitpanel");
}

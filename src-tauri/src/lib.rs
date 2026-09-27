use serde::Serialize;
use tauri::{
    Manager,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
};

mod attachment_storage;
mod clipboard_files;
mod connector_oauth;
mod connector_secrets;
mod device_identity;
mod dingtalk_auth;
mod expert_kits;
mod feedback_images;
mod harness;
mod harness_connectors;
mod html_preview;
mod im;
mod im_registration;
mod local_artifacts;
mod local_file_undo;
mod local_files;
mod local_store;
mod memory;
mod schedule_desktop;
mod task_operations;
#[cfg(target_os = "windows")]
mod window_chrome;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeInfo {
    app_version: &'static str,
    os: &'static str,
    arch: &'static str,
}

#[tauri::command]
fn runtime_info() -> RuntimeInfo {
    RuntimeInfo {
        app_version: env!("CARGO_PKG_VERSION"),
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(harness::HarnessManager::default())
        .manage(connector_oauth::ConnectorOAuthManager::default())
        .manage(im::LocalImManager::default())
        .manage(local_files::LocalFileAuthorizations::default())
        .manage(feedback_images::FeedbackImageGrants::default())
        .manage(html_preview::HtmlPreviewServer::default())
        .setup(|app| {
            let app_data = app.path().app_data_dir()?;
            #[cfg(debug_assertions)]
            if std::env::var_os("XIAOYIN_LOCAL_DEV_WEBVIEW_ISOLATION").is_some() {
                if app.config().identifier != "com.instudio.xiaoyin.desktop.local-test" {
                    return Err(std::io::Error::other(
                        "本地 WebView 隔离仅适用于 local-test 应用标识",
                    )
                    .into());
                }
                let main = app
                    .config()
                    .app
                    .windows
                    .iter()
                    .find(|window| window.label == "main")
                    .ok_or_else(|| std::io::Error::other("本地测试缺少主窗口配置"))?;
                let builder = tauri::WebviewWindowBuilder::from_config(app.handle(), main)?;
                #[cfg(target_os = "macos")]
                let builder = builder.data_store_identifier(*b"xiaoyin-local-01");
                #[cfg(not(target_os = "macos"))]
                let builder = builder.data_directory(app_data.join("webview"));
                builder.build()?;
            }
            let authorizations = app.state::<local_files::LocalFileAuthorizations>();
            #[cfg(target_os = "windows")]
            if let Some(window) = app.get_webview_window("main") {
                window_chrome::hide_caption_icon(&window)?;
            }
            authorizations
                .initialize_workspace(app_data.join("workspace"))
                .and_then(|_| {
                    authorizations.initialize_harness_workspaces_root(app_data.join("workspaces"))
                })
                .map_err(std::io::Error::other)?;
            let show = MenuItem::with_id(app, "show", "打开小胤", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出小胤", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            let mut tray = TrayIconBuilder::with_id("xiaoyin")
                .menu(&menu)
                .tooltip("小胤")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if matches!(event, tauri::tray::TrayIconEvent::DoubleClick { .. }) {
                        show_main_window(tray.app_handle());
                    }
                });
            #[cfg(target_os = "macos")]
            {
                tray = tray
                    .icon(tauri::include_image!("icons/trayTemplate@2x.png"))
                    .icon_as_template(true);
            }
            #[cfg(not(target_os = "macos"))]
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main"
                && let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) =
                    event
            {
                window
                    .state::<feedback_images::FeedbackImageGrants>()
                    .register(paths, dingtalk_auth::mcp::session_epoch());
            }
            if window.label() == "main"
                && let tauri::WindowEvent::CloseRequested { api, .. } = event
            {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            attachment_storage::attachment_storage,
            device_identity::inspect_device_identity,
            connector_secrets::load_connector_secrets,
            connector_oauth::connector_authorization,
            task_operations::task_write_operations,
            connector_secrets::save_connector_secret,
            connector_secrets::delete_connector_secret,
            runtime_info,
            dingtalk_auth::dingtalk_session,
            dingtalk_auth::clear_dingtalk_session,
            dingtalk_auth::open_dingtalk_login,
            expert_kits::list_installed_expert_kits,
            expert_kits::install_expert_kit,
            expert_kits::github::inspect_github_skills,
            expert_kits::github::install_github_skill,
            html_preview::html_artifact_preview_url,
            expert_kits::install_developer_extension,
            expert_kits::select_developer_extension,
            expert_kits::create_developer_extension,
            expert_kits::read_developer_extension,
            expert_kits::workbench::read_extension_contents,
            expert_kits::workbench::set_extension_enabled,
            expert_kits::workbench::reveal_extension_directory,
            expert_kits::package_developer_extension,
            expert_kits::customize_expert_kit,
            expert_kits::export_expert_kit,
            expert_kits::remove_developer_expert_kit,
            expert_kits::remove_developer_extension,
            expert_kits::remove_catalog_extension,
            local_artifacts::read_local_artifact_preview,
            local_artifacts::read_harness_image_preview,
            local_artifacts::reveal_local_artifact,
            local_artifacts::open_local_artifact,
            local_file_undo::undo_local_file_change,
            local_files::authorize_local_directory,
            local_files::authorize_local_files,
            local_files::import_pasted_image,
            local_files::import_pasted_file,
            clipboard_files::clipboard_file_paths,
            feedback_images::read_feedback_image,
            local_files::authorize_standard_local_directories,
            local_files::authorize_dropped_paths,
            local_files::restore_local_directories,
            local_files::revoke_local_directory,
            local_files::clear_local_directories,
            local_store::load_local_tasks,
            local_store::load_local_task,
            local_store::save_local_task,
            local_store::append_local_task_capability_notice,
            local_store::delete_local_task,
            local_store::load_enterprise_catalog_cache,
            local_store::save_enterprise_catalog_cache,
            local_store::load_local_schedules,
            local_store::save_local_schedules,
            local_store::load_local_task_queues,
            local_store::save_local_task_queues,
            local_store::load_local_workspace_state,
            local_store::save_local_workspace_state,
            harness::run_harness,
            harness::diagnose_connectors,
            harness::probe_harness_host,
            harness::check_harness_provider,
            harness::inspect_harness_session,
            harness::search_harness_sessions,
            harness::self_test_local_capabilities,
            harness::cancel_harness,
            harness::steer_harness,
            harness::interrupt_harness,
            harness::fork_harness,
            harness::respond_harness_approval,
            harness::respond_harness_question,
            schedule_desktop::schedule_keep_awake,
            harness::shutdown_harness,
            im::configure_local_dingtalk,
            im::start_local_im,
            im::set_local_im_enabled,
            im::local_im_status,
            im::allow_local_im_pairing,
            im_registration::begin_dingtalk_registration,
            im_registration::poll_dingtalk_registration,
            im::revoke_local_im_pairing,
            im::bind_local_im_task,
            im::unbind_local_im_task,
            im::retry_local_im_delivery,
            im::sync_local_im_tasks,
            im::route_local_im_schedule,
            im::stop_local_im_runtime,
            im::remove_local_dingtalk,
            memory::load_memory_profile,
            memory::load_memory_history,
            memory::save_memory_profile
        ])
        .build(tauri::generate_context!())
        .expect("error while building Xiaoyin desktop")
        .run(|_app, _event| {
            #[cfg(target_os = "macos")]
            if matches!(_event, tauri::RunEvent::Reopen { .. }) {
                show_main_window(_app);
            }
        });
}

pub(crate) fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

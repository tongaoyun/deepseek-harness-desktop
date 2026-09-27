use crate::{local_artifacts::html_preview_response, local_files::LocalFileAuthorizations};
use std::sync::{Arc, Mutex};

#[derive(Default)]
pub(crate) struct HtmlPreviewServer(Mutex<Option<PreviewEndpoint>>);

struct PreviewEndpoint {
    origin: String,
    token: String,
    generation: u64,
    server: Arc<tiny_http::Server>,
}

impl Drop for PreviewEndpoint {
    fn drop(&mut self) {
        self.server.unblock();
    }
}

impl PreviewEndpoint {
    fn start(authorizations: LocalFileAuthorizations) -> Result<Self, String> {
        let generation = authorizations.generation();
        let server =
            Arc::new(tiny_http::Server::http("127.0.0.1:0").map_err(|_| "无法启动本机 HTML 预览")?);
        let address = server.server_addr().to_ip().ok_or("HTML 预览地址无效")?;
        let origin = format!("http://{address}");
        let host = address.to_string();
        let token = uuid::Uuid::new_v4().simple().to_string();
        let prefix = format!("/{token}/");
        let listener = server.clone();
        std::thread::Builder::new()
            .name("html-preview".into())
            .spawn(move || {
                for request in listener.incoming_requests() {
                    let trusted_host = request
                        .headers()
                        .iter()
                        .any(|header| header.field.equiv("Host") && header.value.as_str() == host);
                    let path = request.url().strip_prefix(&prefix);
                    if !trusted_host
                        || request.method() != &tiny_http::Method::Get
                        || path.is_none()
                        || authorizations.generation() != generation
                    {
                        let _ = request.respond(tiny_http::Response::empty(404));
                        continue;
                    }
                    let input = tauri::http::Request::builder()
                        .uri(format!("/{}", path.unwrap()))
                        .body(Vec::new());
                    let Ok(input) = input else {
                        let _ = request.respond(tiny_http::Response::empty(400));
                        continue;
                    };
                    let response = html_preview_response(&authorizations, &input);
                    if authorizations.generation() != generation {
                        let _ = request.respond(tiny_http::Response::empty(404));
                        continue;
                    }
                    let headers = response
                        .headers()
                        .iter()
                        .filter_map(|(name, value)| {
                            tiny_http::Header::from_bytes(name.as_str(), value.as_bytes()).ok()
                        })
                        .collect::<Vec<_>>();
                    let status = response.status().as_u16();
                    let body = response.into_body();
                    let size = body.len();
                    let _ = request.respond(tiny_http::Response::new(
                        status.into(),
                        headers,
                        std::io::Cursor::new(body),
                        Some(size),
                        None,
                    ));
                }
            })
            .map_err(|_| "无法启动 HTML 预览线程")?;
        Ok(Self {
            origin,
            token,
            generation,
            server,
        })
    }

    fn url(&self, root_id: &str, path: &str) -> Result<String, String> {
        let mut url = reqwest::Url::parse(&self.origin).map_err(|_| "HTML 预览地址无效")?;
        url.path_segments_mut()
            .map_err(|_| "HTML 预览地址无效")?
            .extend([self.token.as_str(), root_id, path]);
        Ok(url.into())
    }
}

#[tauri::command]
pub(crate) async fn html_artifact_preview_url(
    app: tauri::AppHandle,
    server: tauri::State<'_, HtmlPreviewServer>,
    authorizations: tauri::State<'_, LocalFileAuthorizations>,
    root_id: String,
    path: String,
) -> Result<String, String> {
    let employee_id = crate::dingtalk_auth::current_employee(&app).await?;
    authorizations.ensure_employee(&employee_id)?;
    authorizations.resolve_artifact(&root_id, &path)?;
    let mut endpoint = server.0.lock().map_err(|_| "HTML 预览服务不可用")?;
    if endpoint
        .as_ref()
        .is_none_or(|value| value.generation != authorizations.generation())
    {
        *endpoint = Some(PreviewEndpoint::start(authorizations.inner().clone())?);
    }
    endpoint.as_ref().unwrap().url(&root_id, &path)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preview_uses_an_untrusted_origin_and_rechecks_live_authorization() {
        tauri::async_runtime::block_on(async {
            let authorizations = LocalFileAuthorizations::default();
            let endpoint = PreviewEndpoint::start(authorizations.clone()).unwrap();
            let client = reqwest::Client::new();
            let url = endpoint.url("missing", "中文 file.html").unwrap();
            assert!(url.starts_with("http://127.0.0.1:"));
            let response = client.get(&url).send().await.unwrap();
            assert_eq!(response.status(), 400);
            assert!(
                response.headers()["content-security-policy"]
                    .to_str()
                    .unwrap()
                    .contains("sandbox allow-scripts")
            );
            assert!(
                !response
                    .headers()
                    .contains_key("access-control-allow-origin")
            );
            assert!(response.text().await.unwrap().contains("授权已失效"));
            assert_eq!(
                client.get(&endpoint.origin).send().await.unwrap().status(),
                404
            );
            assert_eq!(
                client
                    .get(url)
                    .header("Host", "evil.example")
                    .send()
                    .await
                    .unwrap()
                    .status(),
                404
            );
            let stale = endpoint.url("missing", "preview.html").unwrap();
            authorizations.clear().unwrap();
            assert_eq!(client.get(stale).send().await.unwrap().status(), 404);
        });
    }
}

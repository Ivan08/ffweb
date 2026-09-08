//! Keeping other web pages out.
//!
//! The server listens on loopback, which any page the user happens to visit can
//! also reach. A token, carried first in the URL and then in a cookie, plus a
//! check on the Origin header, is what separates this interface from any other
//! site running in the same browser.

use axum::extract::{Request, State};
use axum::http::{header, HeaderValue, StatusCode, Uri};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

use crate::state::SharedState;

/// Name of the cookie the token is remembered in.
const COOKIE: &str = "ffweb_token";

pub async fn guard(State(state): State<SharedState>, request: Request, next: Next) -> Response {
    let Some(token) = state.token.clone() else {
        return next.run(request).await;
    };

    let uri = request.uri().clone();
    // Named `token`, not `t`: the thumbnail endpoint already uses `t` for a
    // timestamp, and a one-letter parameter is exactly the kind of thing a
    // later endpoint collides with.
    let from_query = query_param(&uri, "token");
    let presented = from_query
        .clone()
        .or_else(|| bearer(&request))
        .or_else(|| cookie(&request));

    if presented.as_deref() != Some(token.as_str()) {
        return (
            StatusCode::UNAUTHORIZED,
            "ffweb: missing or wrong access token. Open the URL printed by the CLI.",
        )
            .into_response();
    }

    if is_cross_origin(&request) {
        return (StatusCode::FORBIDDEN, "ffweb: cross-origin request refused").into_response();
    }

    let mut response = next.run(request).await;
    // The token arrives once in the URL; from then on the cookie carries it, so
    // reloads and asset requests do not need the query string.
    if from_query.is_some() {
        if let Ok(value) = HeaderValue::from_str(&format!(
            "{COOKIE}={token}; Path=/; SameSite=Strict; Max-Age=86400"
        )) {
            response.headers_mut().append(header::SET_COOKIE, value);
        }
    }
    response
}

fn bearer(request: &Request) -> Option<String> {
    request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::to_owned)
}

fn cookie(request: &Request) -> Option<String> {
    request
        .headers()
        .get(header::COOKIE)
        .and_then(|value| value.to_str().ok())
        .and_then(|cookies| {
            cookies
                .split(';')
                .filter_map(|pair| pair.trim().split_once('='))
                .find(|(name, _)| *name == COOKIE)
                .map(|(_, value)| value.to_string())
        })
}

/// Whether the request came from somewhere other than this server's own pages.
///
/// A page on another site can carry our cookie, but it cannot forge Origin. A
/// request without the header at all is not cross-origin — plain navigations
/// and same-origin GETs omit it.
fn is_cross_origin(request: &Request) -> bool {
    let Some(origin) = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();

    origin != format!("http://{host}") && origin != format!("https://{host}")
}

/// Read one query parameter, percent-decoded.
pub fn query_param(uri: &Uri, key: &str) -> Option<String> {
    uri.query()?
        .split('&')
        .filter_map(|pair| pair.split_once('='))
        .find(|(name, _)| *name == key)
        .and_then(|(_, value)| urlencoding::decode(value).ok())
        .map(|value| value.into_owned())
}

/// A random token, printed once in the startup URL.
pub fn new_token() -> String {
    use rand::Rng;
    const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    let mut rng = rand::thread_rng();
    (0..24)
        .map(|_| ALPHABET[rng.gen_range(0..ALPHABET.len())] as char)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn uri(query: &str) -> Uri {
        format!("http://127.0.0.1/api/thing?{query}")
            .parse()
            .expect("uri")
    }

    #[test]
    fn reads_a_parameter_by_name() {
        assert_eq!(
            query_param(&uri("token=abc"), "token").as_deref(),
            Some("abc")
        );
        assert_eq!(
            query_param(&uri("a=1&token=abc&b=2"), "token").as_deref(),
            Some("abc")
        );
    }

    #[test]
    fn does_not_confuse_one_parameter_with_another() {
        // The thumbnail endpoint takes `t`; the token is `token`.
        assert_eq!(
            query_param(&uri("t=2.5&token=abc"), "token").as_deref(),
            Some("abc")
        );
        assert_eq!(
            query_param(&uri("t=2.5&token=abc"), "t").as_deref(),
            Some("2.5")
        );
        assert_eq!(query_param(&uri("t=2.5"), "token"), None);
    }

    #[test]
    fn decodes_what_the_browser_encoded() {
        assert_eq!(
            query_param(&uri("path=%2Ftmp%2Fa%20b.mp4"), "path").as_deref(),
            Some("/tmp/a b.mp4")
        );
    }

    #[test]
    fn issues_a_token_that_is_hard_to_guess_and_easy_to_type() {
        let token = new_token();
        assert_eq!(token.len(), 24);
        assert!(token.chars().all(|c| c.is_ascii_alphanumeric()));
        assert_ne!(token, new_token());
    }
}

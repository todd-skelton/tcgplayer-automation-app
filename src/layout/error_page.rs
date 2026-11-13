//! The page for a failed request, drawn inside the layout.
use corten::{http::StatusCode, prelude::*};

use super::Layout;
use crate::app;

/// What a failure says: a missing page, a server that could not answer in time, or anything else.
/// Under `corten dev` it shows the error too.
///
/// It reads nothing itself. For a failure the request is at fault for (a 404, a wrong method, a
/// refusal) Corten starts and waits for the layout's reads, so the app bar's auth cookie warning
/// is drawn as on every page; for a failure of the server's (a timeout, a panic) it waits for none,
/// so a database that is down does not slow the page that says so.
pub async fn error_page(failure: Failure, req: Req) -> HtmlResult {
    let (title, text) = match failure {
        Failure::NotFound => ("Not found", "The requested page could not be found."),
        Failure::TimedOut | Failure::Offline | Failure::Unidentified { .. } => (
            "Not available",
            "The server took too long to answer. Try again in a moment.",
        ),
        // The request did not arrive whole in time (a 408): an upload whose client stopped sending.
        Failure::Failed { status, .. } if status == StatusCode::REQUEST_TIMEOUT => {
            ("Not received", "Check your connection and try again.")
        }
        Failure::WrongMethod
        | Failure::UnknownMethod
        | Failure::CrossSite
        | Failure::Refused { .. }
        | Failure::Rejected { .. }
        | Failure::Failed { .. }
        | Failure::Panicked { .. } => ("Something went wrong", "An unexpected error occurred."),
    };
    let req = &req;
    req.page(html! {
        <Layout req={req} title={title} head="">
            <h1>{title}</h1>
            <p>{text}</p>
            <p><a href={app::url::Home}>"Go to the home page"</a></p>
            if let Some(detail) = failure.detail() {
                <pre>{detail}</pre>
            }
        </Layout>
    })
}

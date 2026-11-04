//! The page for a failed request, in the layout, as the React app's `ErrorBoundary` drew it inside
//! its theme.
use corten::prelude::*;

use super::{Chrome, Layout};
use crate::app;

/// What a failure says: a missing page, a server that could not answer in time, or anything else.
/// Under `corten dev` it shows the error too, as the React screen showed it in development.
///
/// It reads nothing from the database (the auth cookie warning is left off), so a database that
/// is down, the usual reason a page failed, does not slow the page that says so.
pub async fn error_page(failure: Failure, req: Req) -> HtmlResult {
    let (title, text) = match failure {
        Failure::NotFound => ("Not found", "The requested page could not be found."),
        Failure::TimedOut | Failure::Offline | Failure::Unidentified { .. } => (
            "Not available",
            "The server took too long to answer. Try again in a moment.",
        ),
        Failure::WrongMethod
        | Failure::CrossSite
        | Failure::Refused { .. }
        | Failure::Rejected { .. }
        | Failure::Failed { .. }
        | Failure::Panicked { .. } => ("Something went wrong", "An unexpected error occurred."),
    };
    let chrome = Chrome {
        auth_cookie_missing: false,
    };
    let req = &req;
    req.page(html! {
        <Layout req={req} title={title} chrome={chrome} head="">
            <h1>{title}</h1>
            <p>{text}</p>
            <p><a href={app::url::Home}>"Go to the home page"</a></p>
            if let Some(detail) = failure.detail() {
                <pre>{detail}</pre>
            }
        </Layout>
    })
}

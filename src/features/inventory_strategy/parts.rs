//! The screen's slow parts, each sent once read to the `<corten-live>` that waits for it: the
//! selling history, and what the selling earned followed by what the policy and the capital
//! turnaround give. The page reads the same parts in when its address asks (`View::whole`).
use std::sync::Arc;

use corten::{LiveResponse, prelude::*};
use futures_util::stream;
use tokio::sync::OnceCell;

use super::{
    realized,
    screen::{self, Screen, Turnaround},
    url,
    views::{PolicyPart, RealizedPart, SellingHistoryPart, TurnaroundPart},
};
use crate::{database::Database, features::continuous_pricing::store, text::Msg};

/// The selling history over the page's scope once read.
pub async fn selling_history_live(
    req: Req,
    State(db): State<Database>,
    Params(at): Params<url::SellingHistoryLive>,
) -> corten::Result<LiveResponse> {
    let t: Msg = req.t();
    let seller = store::settings(&db).await?.seller_key;
    Ok(corten::live(stream::once(async move {
        let history = screen::load_selling_history(&db, &seller, &at.view.scope()).await;
        SellingHistoryPart {
            history: Some(&history),
            view: &at.view,
            t,
        }
        .to_html()
    })))
}

/// Realized performance once read, then the policy's verdict, the levers and the capital
/// turnaround once the turnaround is rebuilt too: the levers read both, so realized performance
/// is read once for the two.
pub async fn returns_live(
    req: Req,
    State(db): State<Database>,
    Params(at): Params<url::ReturnsLive>,
) -> corten::Result<LiveResponse> {
    let t: Msg = req.t();
    let screen = Arc::new(Screen::first(&db, &at.view).await?);
    let realized = Arc::new(OnceCell::new());
    let earned = {
        let (db, screen, realized) = (db.clone(), screen.clone(), realized.clone());
        async move {
            let realized = realized
                .get_or_init(|| realized::load_with_recovery(&db, &screen.seller_key))
                .await;
            RealizedPart {
                screen: &screen,
                realized: Some(realized),
                t,
            }
            .to_html()
        }
    };
    let policy = async move {
        let (turnaround, realized) = tokio::join!(
            Turnaround::read(&db, &screen.seller_key, &screen.config),
            realized.get_or_init(|| realized::load_with_recovery(&db, &screen.seller_key)),
        );
        html! {
            <PolicyPart
                screen={&screen}
                realized={Some(realized)}
                turnaround={Some(&turnaround)}
                t={t}
            />
            <TurnaroundPart screen={&screen} turnaround={Some(&turnaround)} t={t} />
        }
        .to_html()
    };
    Ok(corten::live(stream::select(
        stream::once(earned),
        stream::once(policy),
    )))
}

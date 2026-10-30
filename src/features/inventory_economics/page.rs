use corten::prelude::*;

use super::{views::EconomicsScreen, workspace};
use crate::{
    database::Database,
    layout::{Chrome, Layout},
    legacy::Legacy,
    text::Msg,
};

pub async fn show(
    req: Req,
    State(db): State<Database>,
    State(legacy): State<Legacy>,
) -> HtmlResult {
    let (chrome, workspace) = tokio::join!(Chrome::read(&db), workspace::read(&legacy));
    let t: Msg = req.t();
    req.page(html! {
        <Layout req={&req} title="Inventory Economics" chrome={chrome} head="">
            <EconomicsScreen workspace={&workspace} t={t} />
        </Layout>
    })
}

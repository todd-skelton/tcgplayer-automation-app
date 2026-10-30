use corten::prelude::*;

use super::{views::EconomicsScreen, workspace};
use crate::{
    database::Database,
    layout::{Chrome, Layout},
    text::Msg,
};

pub async fn show(req: Req, State(db): State<Database>) -> HtmlResult {
    let (chrome, workspace) = tokio::join!(Chrome::read(&db), workspace::read(&db));
    let t: Msg = req.t();
    req.page(html! {
        <Layout req={&req} title="Inventory Economics" chrome={chrome} head="">
            <EconomicsScreen workspace={&workspace} t={t} />
        </Layout>
    })
}

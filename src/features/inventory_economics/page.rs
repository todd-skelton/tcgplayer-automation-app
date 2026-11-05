use corten::prelude::*;

use super::{views::EconomicsScreen, workspace};
use crate::{database::Database, layout::Layout, text::Msg};

pub async fn show(req: Req, State(db): State<Database>) -> HtmlResult {
    let workspace = workspace::read(&db).await;
    let t: Msg = req.t();
    req.page(html! {
        <Layout req={&req} title="Inventory Economics" head="">
            <EconomicsScreen workspace={&workspace} t={t} />
        </Layout>
    })
}

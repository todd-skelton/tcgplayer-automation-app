use corten::{Component, prelude::*};

use crate::{
    database::Database,
    layout::{Chrome, Entry, Glyph, Layout, PRIMARY, ScreenLink},
    theme::*,
    ui::card::{Card, CardHeader},
};

pub const COMPONENTS: &[Component] = &[Dashboard];

pub async fn show(req: Req, State(db): State<Database>) -> HtmlResult {
    let chrome = Chrome::read(&req, &db).await;
    // The view at the top of `html!` owns what it uses, and `page` borrows `req` too.
    let req = &req;
    req.page(html! {
        <Layout req={req} title="Home" chrome={chrome} head="">
            <Dashboard req={req} screens={&PRIMARY} />
        </Layout>
    })
}

/// Each screen as a card: its icon, its name and what it is for. The whole card is the link.
#[component(css)]
fn Dashboard<'a>(req: &'a Req, screens: &'a [Entry]) -> impl Render {
    html! {
        <div class={Dashboard}>
            <h1>"TCGPlayer Automation"</h1>
            <p class={muted()}>"Inventory and pricing automation tools"</p>
            <ul class={Cards}>
                for e in screens {
                    <li>
                        <ScreenLink req={req} screen={&e.screen}>
                            <div class={Card {}}>
                                <div class={CardHeader {}}>
                                    <span class={Icon}><Glyph icon={e.icon} /></span>
                                    <h2>{e.label}</h2>
                                    <p>{e.description}</p>
                                </div>
                            </div>
                        </ScreenLink>
                    </li>
                }
            </ul>
        </div>
    }
}

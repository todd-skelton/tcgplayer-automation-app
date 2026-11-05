//! Text a script fills in from what it counted ("Showing 12 of 40"), in the page's catalog so
//! the browser writes it with no round trip. The rest of the app's text is English in its views.
corten::i18n::messages! {
    pub struct Msg {
        "en" => "locales/en.json",
    }
}

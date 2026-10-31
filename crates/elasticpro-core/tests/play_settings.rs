//! Play settings under config.txt: `UI_PLAY_*` keys lock their fields, `UI_PLAY_EXCLUDE`
//! adds exclusions the page cannot remove, and `UI_PLAY_ENABLED=false` turns display links
//! off. Its own binary: config.txt is loaded once per process.

mod support;

use elasticpro_core::auth::Edition;
use elasticpro_core::settings::{self, Settings};
use elasticpro_core::Core;
use serde_json::{json, Value};
use support::TempDir;

const PASSWORD: &str = "correct-horse-battery";

#[tokio::test]
async fn config_txt_locks_play_fields_and_can_switch_links_off() {
    let txt = Settings::parse("UI_PLAY_ENABLED=false\nUI_PLAY_DELAY_YELLOW_MIN=20\nUI_PLAY_NODE_BLINK=untilack\nUI_PLAY_EXCLUDE=c9\n\
                               UI_PLAY_SPOTLIGHT_WHEN=red, purple\n");
    assert_eq!(txt.warnings().len(), 1, "a spotlight name that does not exist is dropped: {:?}", txt.warnings());
    settings::init_with(txt);
    let dir = TempDir::new("play-locks");
    let c = Core::new_with_rounds(Some(dir.0.clone()), Edition::Hosted, 1);
    let res = c.handle(json!({ "type": "LOGIN", "name": "Admin", "password": elasticpro_core::auth::DEFAULT_PASSWORD })).await;
    let s = res["session"].as_str().unwrap().to_string();
    c.handle(json!({ "type": "USER_SET_PASSWORD", "session": s, "name": "Admin", "password": PASSWORD })).await;
    let call = |m: Value| {
        let (c, s) = (c.clone(), s.clone());
        async move {
            let mut m = m;
            m["session"] = json!(s);
            c.handle(m).await
        }
    };

    let g = call(json!({ "type": "PLAY_CONFIG_GET" })).await;
    assert_eq!(g["managed"], json!(["UI_PLAY_ENABLED", "UI_PLAY_DELAY_YELLOW_MIN", "UI_PLAY_NODE_BLINK", "UI_PLAY_EXCLUDE"]), "{g}");
    assert_eq!(g["watch"]["delayYellowFromMin"], json!(20));
    assert_eq!(g["watch"]["nodeBlink"], json!("untilAck"), "kept in the option's own spelling");
    assert_eq!(g["exclude"], json!([{ "clusterId": "c9", "reason": "set in config.txt", "by": "config.txt", "at": 0, "managed": true }]));
    assert_eq!(g["managedFields"]["watch.delayYellowFromMin"], json!("UI_PLAY_DELAY_YELLOW_MIN"));
    assert_eq!(g["linksEnabled"], json!(false));

    let locked = call(json!({ "type": "PLAY_CONFIG_SET", "settings": { "watch": { "delayYellowFromMin": 25 } } })).await;
    assert_eq!(locked["kind"], json!("managed"), "{locked}");
    let same = call(json!({ "type": "PLAY_CONFIG_SET", "settings": { "watch": { "delayYellowFromMin": 20, "delayRedAboveMin": 45 } } })).await;
    assert_eq!(same["ok"], json!(true), "config.txt's own value is not a change: {same}");
    assert_eq!(same["watch"]["delayRedAboveMin"], json!(45));
    let rm = call(json!({ "type": "PLAY_CONFIG_SET", "settings": { "exclude": { "remove": "c9" } } })).await;
    assert_eq!(rm["kind"], json!("managed"), "{rm}");

    // Links off: none made, none exchanged.
    assert_eq!(call(json!({ "type": "PLAY_LINK_CREATE", "name": "TV" })).await["kind"], json!("disabled"));
    assert_eq!(c.handle(json!({ "type": "PLAY_EXCHANGE", "secret": "epdisplay_x" })).await["kind"], json!("disabled"));
    assert_eq!(c.handle(json!({ "type": "PING" })).await["playLinks"], json!(false));
}

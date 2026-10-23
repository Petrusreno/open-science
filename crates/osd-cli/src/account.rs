// `osd account` — web sign-in accounts, on this machine's own files.
//
// The desktop app manages these in Settings › Remote access; a headless box has
// no Settings, so this is its way to hand someone a name and a password. Like
// `osd auth`, it never goes through the gateway: who may sign in is decided on
// the machine itself.
use osd_core::web_accounts;

use crate::args::Args;

pub fn run(args: &Args) -> Result<(), String> {
    match args.sub.as_str() {
        "ls" | "list" => {
            for name in web_accounts::list(&crate::env(args)?)? {
                println!("{name}");
            }
            Ok(())
        }
        "add" | "set" | "passwd" => {
            let name = args.at(0, "name")?;
            // From the environment, not a flag: a password in argv lands in the
            // shell history and in `ps`.
            let password = std::env::var("OSD_PASSWORD")
                .map_err(|_| "set OSD_PASSWORD to the password (kept out of argv and shell history)".to_string())?;
            web_accounts::set_password(&crate::env(args)?, &name, &password)?;
            println!("account {name} ready; a changed password signs it out everywhere");
            Ok(())
        }
        "rm" | "delete" => {
            let name = args.at(0, "name")?;
            web_accounts::delete(&crate::env(args)?, &name)?;
            println!("account {name} removed");
            Ok(())
        }
        "" => Err("usage: osd account ls | OSD_PASSWORD=… osd account add <name> | osd account rm <name>".into()),
        other => Err(format!("unknown command `osd account {other}`")),
    }
}

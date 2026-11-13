//! Windows notification-area icon.
//!
//! Closing the main window on Windows hides it (see the `CloseRequested`
//! handler), so running agents keep working. This icon is the way back: a left
//! click opens Buzz, and its menu offers Open and Quit. Once the window is
//! hidden it is the way to quit, since Alt+F4 and the taskbar's Close only
//! close the window.
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Runtime,
};

const TRAY_ID: &str = "buzz-tray";
const OPEN_ID: &str = "tray-open";
const QUIT_ID: &str = "tray-quit";

#[derive(Debug, PartialEq, Eq)]
enum TrayCommand {
    Open,
    Quit,
}

fn command(id: &str) -> Option<TrayCommand> {
    match id {
        OPEN_ID => Some(TrayCommand::Open),
        QUIT_ID => Some(TrayCommand::Quit),
        _ => None,
    }
}

/// Only a left-button release opens Buzz: the right button belongs to the
/// menu, and each click also reports a press.
fn opens(event: &TrayIconEvent) -> bool {
    matches!(
        event,
        TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
        }
    )
}

/// Adds Buzz's icon, which lasts as long as the app.
pub(crate) fn install<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let menu = Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, OPEN_ID, "Open Buzz", true, None::<&str>)?,
            &MenuItem::with_id(app, QUIT_ID, "Quit Buzz", true, None::<&str>)?,
        ],
    )?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .tooltip("Buzz")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match command(event.id.as_ref()) {
            Some(TrayCommand::Open) => crate::deep_links::focus_main(app),
            // The same exit as quitting from the app menu: agents stop with Buzz.
            Some(TrayCommand::Quit) => app.exit(0),
            None => {}
        })
        .on_tray_icon_event(|tray, event| {
            if opens(&event) {
                crate::deep_links::focus_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::{tray::TrayIconId, PhysicalPosition, Rect};

    fn click(button: MouseButton, button_state: MouseButtonState) -> TrayIconEvent {
        TrayIconEvent::Click {
            id: TrayIconId::new(TRAY_ID),
            position: PhysicalPosition::new(0.0, 0.0),
            rect: Rect::default(),
            button,
            button_state,
        }
    }

    #[test]
    fn menu_items_open_and_quit() {
        assert_eq!(command(OPEN_ID), Some(TrayCommand::Open));
        assert_eq!(command(QUIT_ID), Some(TrayCommand::Quit));
        assert_eq!(command(""), None);
    }

    #[test]
    fn only_a_left_release_opens_buzz() {
        assert!(opens(&click(MouseButton::Left, MouseButtonState::Up)));
        assert!(!opens(&click(MouseButton::Left, MouseButtonState::Down)));
        assert!(!opens(&click(MouseButton::Right, MouseButtonState::Up)));
        assert!(!opens(&TrayIconEvent::Enter {
            id: TrayIconId::new(TRAY_ID),
            position: PhysicalPosition::new(0.0, 0.0),
            rect: Rect::default(),
        }));
    }
}

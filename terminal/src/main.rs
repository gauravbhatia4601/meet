use clap::Parser;
use uplink_terminal::render::render_ansi;

#[derive(Parser)]
#[command(name = "uplink-terminal", about = "Uplink — terminal-based WebRTC video call")]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
    /// Display name
    #[arg(long, short)]
    name: Option<String>,
}

#[derive(clap::Subcommand)]
enum Command {
    /// Join an existing meeting by code
    Join {
        /// Meeting code (e.g. abc-defg-hij)
        code: String,
        #[arg(long, short)]
        name: Option<String>,
    },
    /// Create a new meeting
    New {
        #[arg(long, short)]
        name: Option<String>,
    },
}

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();

    match cli.command {
        Some(Command::Join { code, name }) => {
            let n = name.as_deref().unwrap_or("Guest");
            println!("Joining room {} as {}...", code, n);
            // TODO: Phase 2 — signaling + WebRTC + video render
        }
        Some(Command::New { name }) => {
            let n = name.as_deref().unwrap_or("Guest");
            println!("Creating new meeting as {}...", n);
            // TODO: Phase 2 — signaling + WebRTC + video render
        }
        None => {
            demo();
        }
    }
    Ok(())
}

fn demo() {
    let width = 80;
    let height = 80; // renders as 40 half-block rows
    let mut rgb = vec![0u8; width * height * 3];
    for y in 0..height {
        for x in 0..width {
            let i = (y * width + x) * 3;
            // Uplink green gradient
            rgb[i] = (x * 255 / width) as u8;
            rgb[i + 1] = 255 - (y * 255 / height) as u8;
            rgb[i + 2] = ((x * y) % 64) as u8;
        }
    }
    let ansi = render_ansi(&rgb, width, height);
    print!("{}", ansi);
    println!();
}
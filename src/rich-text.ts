/**
 * Rich-text sending for Messages.app.
 *
 * Why this exists:
 * - AppleScript can send plain text to Messages.app, but it does not provide a
 *   good way to construct and send formatted rich text.
 * - Node.js can drive shell commands and UI automation, but it cannot natively
 *   create an AppKit NSAttributedString or write RTF to the macOS pasteboard.
 *
 * How it works:
 * 1. Parse the input text into styled spans (currently basic markdown markers).
 * 2. Generate a tiny temporary Swift/AppKit program at runtime.
 * 3. Run that Swift helper to place both RTF and plain text on the pasteboard.
 * 4. Open the target Messages conversation and paste/send via UI automation.
 *
 * Notes:
 * - This is intentionally self-contained: there is no checked-in Swift helper file.
 * - Because sending uses UI automation, it is best-effort and can be disrupted if
 *   the user is actively interacting with Messages or changing app focus.
 * - This path is currently intended for direct-message iMessage chats.
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_RICH_TEXT_OPTIONS = { markdown: true } as const;

export interface RichTextOptions {
	markdown?: boolean;
}

interface Span {
	text: string;
	bold: boolean;
	italic: boolean;
	strikethrough: boolean;
}

const RICH_TEXT_SWIFT_SOURCE = String.raw`
import AppKit
import Foundation

struct Span: Decodable {
    let text: String
    let bold: Bool
    let italic: Bool
    let strikethrough: Bool
}

struct CLI {
    let spansFile: String

    static func parse() -> CLI? {
        var spansFile: String?
        var i = 1
        let args = CommandLine.arguments
        while i < args.count {
            switch args[i] {
            case "--spans-file":
                i += 1
                if i < args.count { spansFile = args[i] }
            default:
                break
            }
            i += 1
        }
        guard let spansFile else { return nil }
        return CLI(spansFile: spansFile)
    }
}

guard let cli = CLI.parse() else {
    fputs("Missing --spans-file\n", stderr)
    exit(2)
}

let data = try Data(contentsOf: URL(fileURLWithPath: cli.spansFile))
let spans = try JSONDecoder().decode([Span].self, from: data)
let attr = NSMutableAttributedString()

for span in spans {
    let font: NSFont
    if span.bold && span.italic {
        font = NSFontManager.shared.convert(NSFont.boldSystemFont(ofSize: 15), toHaveTrait: .italicFontMask)
    } else if span.bold {
        font = NSFont.boldSystemFont(ofSize: 15)
    } else if span.italic {
        font = NSFontManager.shared.convert(NSFont.systemFont(ofSize: 15), toHaveTrait: .italicFontMask)
    } else {
        font = NSFont.systemFont(ofSize: 15)
    }
    var attributes: [NSAttributedString.Key: Any] = [.font: font]
    if span.strikethrough {
        attributes[.strikethroughStyle] = NSNumber(value: NSUnderlineStyle.single.rawValue)
    }
    attr.append(NSAttributedString(string: span.text, attributes: attributes))
}

let full = NSRange(location: 0, length: attr.length)
let pb = NSPasteboard.general
pb.clearContents()
let rtf = try attr.data(from: full, documentAttributes: [.documentType: NSAttributedString.DocumentType.rtf])
pb.setData(rtf, forType: .rtf)
pb.setString(attr.string, forType: .string)
print("OK")
`;

function recipientFromChatGuid(chatGuid: string): string {
	return chatGuid.split(";").pop() ?? chatGuid;
}

function parseMarkdownToSpans(markdown: string): Span[] {
	const spans: Span[] = [];
	const pattern = /(\*\*[^*]+\*\*|~~[^~]+~~|__[^_]+__|_[^_]+_)/g;
	let lastIndex = 0;
	for (const match of markdown.matchAll(pattern)) {
		const index = match.index ?? 0;
		if (index > lastIndex) {
			spans.push({ text: markdown.slice(lastIndex, index), bold: false, italic: false, strikethrough: false });
		}
		const token = match[0];
		if (token.startsWith("**") && token.endsWith("**")) {
			spans.push({ text: token.slice(2, -2), bold: true, italic: false, strikethrough: false });
		} else if (token.startsWith("~~") && token.endsWith("~~")) {
			spans.push({ text: token.slice(2, -2), bold: false, italic: false, strikethrough: true });
		} else if (token.startsWith("__") && token.endsWith("__")) {
			spans.push({ text: token.slice(2, -2), bold: false, italic: true, strikethrough: false });
		} else if (token.startsWith("_") && token.endsWith("_")) {
			spans.push({ text: token.slice(1, -1), bold: true, italic: false, strikethrough: false });
		}
		lastIndex = index + token.length;
	}
	if (lastIndex < markdown.length) {
		spans.push({ text: markdown.slice(lastIndex), bold: false, italic: false, strikethrough: false });
	}
	return spans;
}

function plainTextToSpans(text: string): Span[] {
	return [{ text, bold: false, italic: false, strikethrough: false }];
}

async function openConversation(recipient: string): Promise<void> {
	const encoded = encodeURIComponent(recipient);
	await execFileAsync("open", [`messages://open?addresses=${encoded}`], { timeout: 10_000 });
}

async function pasteAndSend(): Promise<void> {
	// UI automation is the final leg: bring Messages to the front, paste the RTF
	// payload from the pasteboard, then press Return to send.
	const script = `tell application "Messages" to activate
 delay 1.0
 tell application "System Events"
   tell process "Messages"
     set frontmost to true
     keystroke "v" using command down
     delay 0.5
     key code 36
   end tell
 end tell`;
	await execFileAsync("osascript", ["-e", script], { timeout: 30_000 });
}

async function copyRichTextToClipboard(text: string, options?: RichTextOptions): Promise<void> {
	const resolvedOptions = { ...DEFAULT_RICH_TEXT_OPTIONS, ...options };
	const dir = await mkdtemp(join(tmpdir(), "pi-imessage-rich-"));
	const swiftPath = join(dir, "RichTextSender.swift");
	const spansPath = join(dir, "spans.json");
	const spans = resolvedOptions.markdown ? parseMarkdownToSpans(text) : plainTextToSpans(text);
	try {
		await writeFile(swiftPath, RICH_TEXT_SWIFT_SOURCE, "utf-8");
		await writeFile(spansPath, JSON.stringify(spans), "utf-8");
		await execFileAsync("swift", [swiftPath, "--spans-file", spansPath], { timeout: 60_000 });
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

export async function sendRichTextMessage(chatGuid: string, text: string, options?: RichTextOptions): Promise<void> {
	const parts = chatGuid.split(";");
	const isGroup = parts[1] === "+";
	if (isGroup) {
		throw new Error("Rich-text sending is currently only supported for direct-message chats");
	}
	const recipient = recipientFromChatGuid(chatGuid);
	await copyRichTextToClipboard(text, options);
	await openConversation(recipient);
	await pasteAndSend();
	console.log(`[send] sent rich text to ${chatGuid}: "${text.substring(0, 60)}"`);
}

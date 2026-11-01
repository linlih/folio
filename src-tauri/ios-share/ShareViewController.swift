import UIKit
import UniformTypeIdentifiers

/// "Folio" in the iOS share sheet (design/inbox-and-tags.md §2). What was
/// shared goes, as one text file, into the folder this extension shares
/// with the app; the app takes the files when it comes to the front
/// (take_shared in src-tauri/src/lib.rs) and saves them to the inbox.
/// Nothing is fetched here: the app reads titles and summaries itself.
final class ShareViewController: UIViewController {
    /// Also in the app's entitlements (scripts/ios-share.sh) and lib.rs.
    static let group = "group.dev.folio.app"

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
        Task { @MainActor in
            let text = await sharedText()
            let saved = text.map(Self.save) ?? false
            show(saved ? Self.words("已存入 Folio 收集箱", "Saved to the Folio inbox") : Self.words("没有可以收下的文字或链接", "Nothing to save"))
            try? await Task.sleep(nanoseconds: 700_000_000)
            extensionContext?.completeRequest(returningItems: nil)
        }
    }

    /// The shared words and link as one text, the way Android hands them
    /// over: the words, then the link unless the words already have it.
    private func sharedText() async -> String? {
        var words: [String] = []
        var link: String?
        for item in extensionContext?.inputItems as? [NSExtensionItem] ?? [] {
            if let text = item.attributedContentText?.string { words.append(text) }
            for provider in item.attachments ?? [] {
                if link == nil, provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
                   let url = try? await provider.loadItem(forTypeIdentifier: UTType.url.identifier) {
                    link = (url as? URL)?.absoluteString ?? (url as? Data).flatMap { URL(dataRepresentation: $0, relativeTo: nil)?.absoluteString }
                } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
                          let text = try? await provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) {
                    if let text = (text as? String) ?? (text as? Data).flatMap({ String(data: $0, encoding: .utf8) }) { words.append(text) }
                }
            }
        }
        var seen = Set<String>()
        var text = words.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty && seen.insert($0).inserted }
            .joined(separator: "\n")
        if let link, !text.contains(link) { text = text.isEmpty ? link : text + "\n" + link }
        return text.isEmpty ? nil : text
    }

    /// Writes `text` as shared/<milliseconds>-<random>.txt, so the app
    /// takes several shares in the order they came.
    private static func save(_ text: String) -> Bool {
        guard let box = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else { return false }
        let dir = box.appendingPathComponent("shared", isDirectory: true)
        let name = "\(Int(Date().timeIntervalSince1970 * 1000))-\(UUID().uuidString).txt"
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            try Data(text.utf8).write(to: dir.appendingPathComponent(name), options: .atomic)
            return true
        } catch {
            return false
        }
    }

    private static func words(_ zh: String, _ en: String) -> String {
        Locale.preferredLanguages.first?.hasPrefix("zh") == true ? zh : en
    }

    /// A short note in the middle of the screen while the sheet closes.
    private func show(_ text: String) {
        let label = UILabel()
        label.text = text
        label.font = .preferredFont(forTextStyle: .body)
        label.textColor = .label
        label.numberOfLines = 0
        label.textAlignment = .center
        let box = UIView()
        box.backgroundColor = .secondarySystemBackground
        box.layer.cornerRadius = 14
        box.translatesAutoresizingMaskIntoConstraints = false
        label.translatesAutoresizingMaskIntoConstraints = false
        box.addSubview(label)
        view.addSubview(box)
        NSLayoutConstraint.activate([
            box.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            box.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            box.widthAnchor.constraint(lessThanOrEqualTo: view.widthAnchor, constant: -64),
            label.topAnchor.constraint(equalTo: box.topAnchor, constant: 16),
            label.bottomAnchor.constraint(equalTo: box.bottomAnchor, constant: -16),
            label.leadingAnchor.constraint(equalTo: box.leadingAnchor, constant: 20),
            label.trailingAnchor.constraint(equalTo: box.trailingAnchor, constant: -20),
        ])
    }
}

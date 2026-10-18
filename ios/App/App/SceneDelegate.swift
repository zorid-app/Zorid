import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    private let imports = NativeImportCoordinator()
    private var coldLinkObserver: NSObjectProtocol?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = UINavigationController(rootViewController: NativeVaultPicker())
        window?.makeKeyAndVisible()
        if let presenter = window?.rootViewController { imports.recover(from: presenter) }

        let external = connectionOptions.urlContexts.filter { $0.url.isFileURL }
        let activityFiles = connectionOptions.userActivities.compactMap { $0.webpageURL }.filter(\.isFileURL)
        if external.isEmpty && activityFiles.isEmpty {
            SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
        } else {
            // Capacitor's cold proxy captures ALL URLs until its first web view.
            // Do not send native provider paths to that deferred renderer event.
            // Preserve its connection notification and deferred unrelated links.
            NotificationCenter.default.post(name: .capacitorSceneWillConnect, object: scene)
            let links = Set(connectionOptions.urlContexts.filter { !$0.url.isFileURL })
            let activities = connectionOptions.userActivities.filter { $0.webpageURL?.isFileURL != true }
            coldLinkObserver = NotificationCenter.default.addObserver(forName: .capacitorViewDidAppear, object: nil, queue: .main) { [weak self] _ in
                guard let self = self else { return }
                if let observer = self.coldLinkObserver { NotificationCenter.default.removeObserver(observer); self.coldLinkObserver = nil }
                if !links.isEmpty { SceneDelegateProxy.shared.scene(scene, openURLContexts: links) }
                for activity in activities { self.scene(scene, continue: activity) }
            }
            if let presenter = window?.rootViewController {
                imports.receiveOpenIn(external.map(\.url) + activityFiles, from: presenter)
            }
        }
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        if let presenter = window?.rootViewController { imports.resumeExternal(from: presenter) }
    }

    func sceneDidDisconnect(_ scene: UIScene) {
        if let observer = coldLinkObserver { NotificationCenter.default.removeObserver(observer); coldLinkObserver = nil }
    }

    func sceneDidEnterBackground(_ scene: UIScene) {
        let navigation = window?.rootViewController as? UINavigationController
        (navigation?.topViewController as? NativeEditorContainer)?.enterBackground()
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        if let presenter = window?.rootViewController {
            imports.receiveOpenIn(URLContexts.map(\.url), from: presenter)
        }
        let unrelated = Set(URLContexts.filter { !$0.url.isFileURL })
        if !unrelated.isEmpty { SceneDelegateProxy.shared.scene(scene, openURLContexts: unrelated) }
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        if let url = userActivity.webpageURL, url.isFileURL {
            if let presenter = window?.rootViewController { imports.receiveOpenIn([url], from: presenter) }
        } else {
            SceneDelegateProxy.shared.scene(scene, continue: userActivity)
        }
    }
}

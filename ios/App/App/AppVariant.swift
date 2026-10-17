import Foundation

/// Product identity, independent of DEBUG, optimization and signing method.
/// Native strings/assets/UI can consult this when a deliberate variant-specific
/// choice is introduced. Current app behavior and resources are shared.
enum AppVariant: String {
    case development
    case production

    /// Missing, unexpanded or unknown metadata is not silently treated as prod.
    /// Callers can handle misconfigured bundles without guessing from DEBUG.
    static var current: AppVariant? { resolve(in: .main) }

    static func resolve(in bundle: Bundle) -> AppVariant? {
        guard let expected = compiledVariant,
              let value = bundle.object(forInfoDictionaryKey: "ZoridAppEnvironment") as? String,
              let variant = AppVariant(rawValue: value), variant == expected else { return nil }
        return variant
    }

    private static var compiledVariant: AppVariant? {
        #if ZORID_DEVELOPMENT && !ZORID_PRODUCTION
        return .development
        #elseif ZORID_PRODUCTION && !ZORID_DEVELOPMENT
        return .production
        #else
        return nil
        #endif
    }
}

import UIKit

// Release-triggered UI intent only. The owning controller/root still authorizes
// the route, save/close and fresh destination. There is no interactive preview.
@MainActor
final class NativeRouteEdgeGestures: NSObject, UIGestureRecognizerDelegate {
    private struct Intent {
        let recognizerID: ObjectIdentifier
        let direction: Int
        let context: UUID
        let layoutDirection: UIUserInterfaceLayoutDirection
        let inwardSign: CGFloat
        let bounds: CGRect
    }

    private weak var view: UIView?
    private let context: (Int) -> UUID?
    private let navigate: (Int) -> Void
    private let allowsUnfocusedTextInput: Bool
    private var recognizers: [UIScreenEdgePanGestureRecognizer] = []
    private var intent: Intent?
    private var invalidated = false
    private weak var touchedScrollView: UIScrollView?

    init(view: UIView, allowsUnfocusedTextInput: Bool = false, context: @escaping (Int) -> UUID?, navigate: @escaping (Int) -> Void) {
        self.view = view
        self.allowsUnfocusedTextInput = allowsUnfocusedTextInput
        self.context = context
        self.navigate = navigate
        super.init()
        for edge in [UIRectEdge.left, .right] {
            let recognizer = UIScreenEdgePanGestureRecognizer(target: self, action: #selector(changed(_:)))
            recognizer.edges = edge // Public API requires edges before attachment.
            recognizer.maximumNumberOfTouches = 1
            recognizer.delegate = self
            // Keep normal touch cancellation: one accepted pan must not also
            // activate a row. Do not alter any other recognizer or its delegate.
            view.addGestureRecognizer(recognizer)
            recognizers.append(recognizer)
        }
    }

    func cancelPendingGesture() {
        intent = nil
        guard !invalidated else { return }
        for recognizer in recognizers {
            recognizer.isEnabled = false
            recognizer.isEnabled = true
        }
    }

    func invalidate() {
        invalidated = true
        intent = nil
        for recognizer in recognizers {
            recognizer.isEnabled = false
            recognizer.delegate = nil
            recognizer.removeTarget(self, action: #selector(changed(_:)))
            view?.removeGestureRecognizer(recognizer)
        }
        recognizers.removeAll()
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        // A second touch must not leave a previously armed route intent alive,
        // even when that touch belongs to a control excluded below.
        if intent != nil { intent = nil; return false }
        touchedScrollView = nil
        guard !invalidated, let view = view, let touched = touch.view,
              touched === view || touched.isDescendant(of: view), touch.type == .direct else { return false }
        // Public control/text-input types only; no WebKit/SwiftUI private classes
        // or recognizer traversal. Buttons and text selection retain their input.
        var candidate: UIView? = touched
        while let current = candidate {
            if current is UIControl { return false }
            // WK content also conforms to UITextInput when no DOM editor is
            // focused. Only the editor owner may opt in, with its strict native
            // selection/composition/revision context checked at begin AND end.
            if current is UITextInput && !allowsUnfocusedTextInput { return false }
            if let scroll = current as? UIScrollView {
                guard !scroll.isDragging, !scroll.isDecelerating, !scroll.isZooming else { return false }
                touchedScrollView = scroll
            }
            if current === view { break }
            candidate = current.superview
        }
        return true
    }

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard intent == nil, !invalidated, let view = view,
              let recognizer = gestureRecognizer as? UIScreenEdgePanGestureRecognizer,
              recognizers.contains(where: { $0 === recognizer }), validGeometry(view),
              recognizer.numberOfTouches == 1 else { return false }
        if let scroll = touchedScrollView, scroll.isDragging || scroll.isDecelerating || scroll.isZooming { return false }
        let sign: CGFloat = recognizer.edges == .left ? 1 : -1
        let velocity = recognizer.velocity(in: view)
        guard velocity.x.isFinite, velocity.y.isFinite,
              velocity.x * sign > 0, abs(velocity.x) > 1.5 * abs(velocity.y) else { return false }
        let layout = view.effectiveUserInterfaceLayoutDirection
        let direction = (recognizer.edges == .left) == (layout == .leftToRight) ? -1 : 1
        guard let token = context(direction) else { return false }
        intent = Intent(recognizerID: ObjectIdentifier(recognizer), direction: direction,
                        context: token, layoutDirection: layout, inwardSign: sign, bounds: view.bounds)
        return true
    }

    private func validGeometry(_ view: UIView) -> Bool {
        view.bounds.width.isFinite && view.bounds.height.isFinite
            && view.bounds.width > 0 && view.bounds.height > 0
    }

    @objc private func changed(_ recognizer: UIScreenEdgePanGestureRecognizer) {
        guard intent?.recognizerID == ObjectIdentifier(recognizer) else { return }
        switch recognizer.state {
        case .ended:
            let original = intent
            intent = nil // Consume before root can synchronously change the source.
            guard !invalidated, let original = original, let view = view, validGeometry(view),
                  view.bounds == original.bounds,
                  view.effectiveUserInterfaceLayoutDirection == original.layoutDirection,
                  context(original.direction) == original.context else { return }
            let translation = recognizer.translation(in: view)
            let threshold = min(CGFloat(80), max(CGFloat(48), view.bounds.width * 0.15))
            guard translation.x.isFinite, translation.y.isFinite,
                  translation.x * original.inwardSign >= threshold,
                  abs(translation.x) > 1.5 * abs(translation.y) else { return }
            navigate(original.direction)
        case .cancelled, .failed:
            intent = nil
        default:
            break // No routing, host work or history staging at begin/change.
        }
    }
}

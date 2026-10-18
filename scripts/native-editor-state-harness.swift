// Concatenated after the exact production state/validator by the runner.
var checks = 0
func check(_ condition: @autoclosure () -> Bool, _ label: String) {
    checks += 1
    precondition(condition(), label)
}
let ready: [String: Any] = ["focused": false, "editable": false, "canUndo": true, "canRedo": false,
    "selectionCollapsed": true, "composing": false, "interactionActive": false, "navigationRevision": 10]
let fields = ["focused", "editable", "canUndo", "canRedo", "selectionCollapsed", "composing", "interactionActive"]
let first = NativeEditorState.decode(ready)!
check(first.permitsRouteGesture, "unfocused collapsed body eligible")
for key in ready.keys {
    var missing = ready; missing.removeValue(forKey: key)
    check(NativeEditorState.decode(missing) == nil, "missing field rejected")
}
var extra = ready; extra["unknown"] = false
check(NativeEditorState.decode(extra) == nil, "unknown field rejected")
for key in fields {
    for invalid: Any in [NSNumber(value: 1), "true", NSNull(), [:] as [String: Any]] {
        var payload = ready; payload[key] = invalid
        check(NativeEditorState.decode(payload) == nil, "boolean must be real CFBoolean")
    }
}
for invalid: Any in [NSNumber(value: true), -1, 0.5, Double.infinity, Double.nan, 9_007_199_254_740_992.0, "10", NSNull()] {
    var payload = ready; payload["navigationRevision"] = invalid
    check(NativeEditorState.decode(payload) == nil, "revision must be safe nonnegative integer")
}
for valid in [0.0, 1.0, 9_007_199_254_740_991.0] {
    var payload = ready; payload["navigationRevision"] = valid
    check(NativeEditorState.decode(payload)?.navigationRevision == UInt64(valid), "safe revision accepted")
}
for key in ["focused", "editable", "composing", "interactionActive"] {
    var payload = ready; payload[key] = true
    check(NativeEditorState.decode(payload)?.permitsRouteGesture == false, "interaction disables gesture")
}
var selection = ready; selection["selectionCollapsed"] = false
check(NativeEditorState.decode(selection)?.permitsRouteGesture == false, "range selection disables gesture")
var validator = NativeEditorStateValidator()
check(try! validator.validate(first) == first, "first real state accepted")
check(try! validator.validate(first) == first, "identical fresh republish accepted")
check(try! validator.validate(.inactive) == .inactive, "unsafe disable always accepted")
check(validator.lastValidated == first, "disable does not lower semantic watermark")
func rejected(_ value: NativeEditorState?, _ expected: NativeEditorStateValidator.Failure) {
    do { _ = try validator.validate(value); check(false, "must reject") }
    catch { check(error as? NativeEditorStateValidator.Failure == expected, "exact rejection") }
    check(validator.lastValidated == first, "rejection retains semantic watermark")
}
rejected(nil, .invalid)
var lower = ready; lower["navigationRevision"] = 9
rejected(NativeEditorState.decode(lower), .stale)
for key in fields {
    var changed = ready; changed[key] = !(changed[key] as! Bool)
    rejected(NativeEditorState.decode(changed), .stale)
}
check(try! validator.validate(first) == first, "same fresh state works after disables/rejections")
var newer = ready; newer["navigationRevision"] = 11
check(try! validator.validate(NativeEditorState.decode(newer)).navigationRevision == 11, "higher revision accepted")
print("PASS \(checks) actual-source native editor state assertions (Foundation only)")

import Foundation

enum TestError: Error { case injected }
@MainActor enum Trace { static var events: [String] = [] }
@MainActor class UIViewController { var parent: UIViewController?; var isViewLoaded = false }
@MainActor final class NativeEditorContainer: UIViewController {
    func documentTabRetirementReceipt(sourceOwnerID: UUID) -> UUID? { nil }
}
struct NativeDocumentTab { let isHome = false }
struct NativeTabDocument {}
@MainActor final class NativeMobileSession {
    var closeCompletion: (() -> Void)?
    func close(completion: @escaping () -> Void) { Trace.events.append("close-request"); closeCompletion = completion }
    func acknowledgeClose() { Trace.events.append("close-ACK"); let done = closeCompletion!; closeCompletion = nil; done() }
}
@MainActor struct NativeExclusiveSessionBinding {
    let session: NativeMobileSession; let localStoreId: String
    let folderId: String?; let folderPath: String
    let finish: (Result<Void, Error>) -> Void
}
@MainActor final class NativeNewNoteRequest {
    enum Action { case inspectPending, create, resumePending }
    enum Outcome { case clear, rejected, pending, ready }
    static var instances: [NativeNewNoteRequest] = []
    var retainsReservation = true
    var execution: ((Result<Outcome, Error>) -> Void)?
    var fence: ((Result<Void, Error>) -> Void)?
    var actions: [Action] = []
    let binding: NativeExclusiveSessionBinding
    init(binding: NativeExclusiveSessionBinding) { self.binding = binding; Self.instances.append(self) }
    func execute(_ action: Action, completion: @escaping (Result<Outcome, Error>) -> Void) {
        actions.append(action); execution = completion; Trace.events.append("inspect")
    }
    func deliver(_ outcome: Outcome, released: Bool = false) {
        if released { retainsReservation = false; Trace.events.append("release-ACK") }
        let done = execution!; execution = nil; done(.success(outcome))
    }
    func fail() { let done = execution!; execution = nil; done(.failure(TestError.injected)) }
    func closeRetainedReservation(completion: @escaping (Result<Void, Error>) -> Void) {
        Trace.events.append("fence-request"); fence = completion
    }
    func acknowledgeFence(_ success: Bool) {
        Trace.events.append(success ? "fence-ACK" : "fence-failure")
        if success { retainsReservation = false }
        let done = fence!; fence = nil; done(success ? .success(()) : .failure(TestError.injected))
    }
}

@MainActor final class FactoryHarness {
    typealias Prepared = Void
    typealias NewNoteRecovery = (@escaping (Result<Void, Error>) -> Void) -> Void
    private var reservation: Reservation?
    private var retiredOwners: [UUID] = []
    private var pendingNewNote: ((@escaping NewNoteRecovery) -> Void)?
    private func closeContainer(_ current: Reservation, completion: @escaping (Result<Void, Error>) -> Void) { preconditionFailure("unused editor path") }
    // INSERT ACTUAL FACTORY METHODS
}

extension FactoryHarness {
    static func runChecks() {
        var count = 0
        func check(_ condition: Bool, _ description: String) { precondition(condition, description); count += 1; print("PASS \(description)") }
        final class Observation {
            var resume: NewNoteRecovery?; var delivered = 0; var cleared = 0; var result: Result<Void, Error>?
        }
        func fixture() -> (FactoryHarness, Reservation, NativeMobileSession, Observation, NativeNewNoteRequest) {
            Trace.events = []; NativeNewNoteRequest.instances = []
            let factory = FactoryHarness(), session = NativeMobileSession(), observation = Observation()
            let reservation = Reservation(tab: NativeDocumentTab(), ownerID: UUID()) { result in
                observation.delivered += 1; Trace.events.append("preparation-failure")
                if case .success = result { preconditionFailure("inspection must not deliver editor") }
            }
            reservation.session = session; factory.reservation = reservation
            factory.pendingNewNote = { observation.resume = $0; Trace.events.append("offer-resume") }
            factory.inspectNewNote(reservation, session: session, store: "store") { observation.cleared += 1 }
            return (factory,reservation,session,observation,NativeNewNoteRequest.instances[0])
        }
        do {
            let (_,reservation,_,observation,helper) = fixture()
            check(reservation.opening && observation.resume == nil, "inspection keeps reservation opening until callback")
            check(helper.actions.count == 1 && { if case .inspectPending = helper.actions[0] { return true }; return false }(), "factory dispatches inspection only")
            helper.deliver(.clear,released: true)
            check(observation.cleared == 1 && reservation.newNoteInspection == nil && !reservation.opening, "clear releases helper before ordinary continuation")
        }
        do {
            let (factory,reservation,session,observation,helper) = fixture()
            helper.deliver(.pending)
            check(factory.reservation === reservation && reservation.newNoteInspection === helper && helper.retainsReservation, "pending retains exact helper and reservation")
            check(observation.resume != nil && observation.delivered == 0 && session.closeCompletion == nil && helper.fence == nil, "pending exposes Resume without automatic fence close or failure")
            observation.resume! { observation.result = $0; Trace.events.append("root-recovery-success") }
            check(helper.fence != nil && session.closeCompletion == nil && observation.delivered == 0, "explicit Resume awaits exact fence ACK before close")
            var duplicateFailed = false
            observation.resume! { if case .failure = $0 { duplicateFailed = true } }
            check(duplicateFailed && Trace.events.filter { $0 == "fence-request" }.count == 1, "concurrent Resume cannot issue another fence")
            helper.acknowledgeFence(true)
            check(session.closeCompletion != nil && observation.delivered == 0 && observation.result == nil, "fence ACK starts close without early preparation failure")
            session.acknowledgeClose()
            check(factory.reservation == nil && observation.delivered == 1 && reservation.newNoteInspection == nil, "host close ACK retires exact helper and reservation once")
            check(Trace.events.firstIndex(of: "close-ACK")! < Trace.events.firstIndex(of: "preparation-failure")! && Trace.events.firstIndex(of: "preparation-failure")! < Trace.events.firstIndex(of: "root-recovery-success")!, "actual close precedes preparation failure and root route permission")
        }
        do {
            let (factory,reservation,session,observation,helper) = fixture()
            helper.deliver(.pending)
            observation.resume! { observation.result = $0 }
            helper.acknowledgeFence(false)
            check(factory.reservation === reservation && reservation.newNoteInspection === helper && helper.retainsReservation && !reservation.closing, "fence failure retains exact actionable helper reservation")
            check(session.closeCompletion == nil && observation.delivered == 0, "failed fence does not close or claim preparation failure")
            observation.result = nil; observation.resume! { observation.result = $0 }
            helper.acknowledgeFence(true); session.acknowledgeClose()
            check(NativeNewNoteRequest.instances.count == 1 && observation.delivered == 1, "retry uses same helper and closes once after ACK")
        }
        do {
            let (factory,reservation,session,observation,helper) = fixture()
            var cleaned = false
            factory.recoverReservation(reservation.ownerID) { if case .success = $0 { cleaned = true } }
            check(reservation.cleanupRequested && reservation.opening && session.closeCompletion == nil && helper.fence == nil, "cleanup during inspection waits existing operation")
            helper.deliver(.pending)
            check(observation.resume == nil && helper.fence != nil && !cleaned, "requested cleanup joins retained pending ownership after inspection")
            helper.acknowledgeFence(true)
            check(!cleaned && observation.delivered == 0, "cleanup still waits actual host close")
            session.acknowledgeClose()
            check(cleaned && observation.delivered == 1 && factory.reservation == nil, "cleanup reports success only after actual close ACK")
        }
        do {
            let (factory,reservation,session,observation,helper) = fixture()
            helper.deliver(.ready,released: true)
            check(reservation.newNoteInspection === helper && observation.cleared == 0 && observation.resume != nil && observation.delivered == 0, "committed ready inspection still requires explicit Resume")
            observation.resume! { observation.result = $0 }
            check(factory.reservation === reservation && helper.fence == nil && session.closeCompletion != nil && observation.delivered == 0, "released ready helper skips fence but still waits host close")
            session.acknowledgeClose()
            check(observation.delivered == 1, "ready recovery completes only after host close ACK")
        }
        do {
            let (factory,reservation,_,observation,helper) = fixture()
            helper.fail()
            check(factory.reservation === reservation && reservation.newNoteInspection === helper && observation.resume != nil && observation.delivered == 0, "inspection error retains actionable helper without premature failure")
        }
        print("\(count) factory checks passed")
    }
}

@main struct Main { @MainActor static func main() { FactoryHarness.runChecks() } }

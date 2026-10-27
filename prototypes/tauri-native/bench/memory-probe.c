/* Throwaway macOS benchmark observer; no task ports, suspension or mutation.
 * Local SDK: libproc.h proc_pid_rusage and sys/resource.h rusage_info_v4.
 * ri_phys_footprint is kernel ledger accounting (includes compressed charges),
 * not RSS and not an exact deduplicated union of physical mapped pages.
 * Formula documentation: https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/kern/task.c
 * Responsible PID is an optional PRIVATE observational API resolved via dlsym.
 * Its signature is also used by Chromium's base/process/process_info_mac.cc:
 * https://chromium.googlesource.com/chromium/src/+/24aa2a50ac03698e7ec5a11251a615b965f5874d/base/process/process_info_mac.cc
 */
#include <dlfcn.h>
#include <errno.h>
#include <inttypes.h>
#include <libproc.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc_info.h>
#include <sys/resource.h>
#include <unistd.h>

static void json_string(const char *s) {
    putchar('"');
    for (const unsigned char *p = (const unsigned char *)s; *p; ++p) {
        if (*p == '"' || *p == '\\') { putchar('\\'); putchar(*p); }
        else if (*p < 32) printf("\\u%04x", *p);
        else putchar(*p);
    }
    putchar('"');
}

static void error_field(const char *operation, int code) {
    printf(",\"error\":{\"operation\":"); json_string(operation);
    printf(",\"errno\":%d,\"message\":", code); json_string(strerror(code)); putchar('}');
}

static void sample(pid_t pid, pid_t (*responsible)(pid_t)) {
    struct proc_bsdinfo before = {0}, after = {0};
    struct rusage_info_v4 usage = {0};
    printf("{\"pid\":%d,\"responsibilityAPI\":%s", pid, responsible ? "true" : "false");
    errno = 0;
    if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &before, sizeof(before)) != sizeof(before)) {
        error_field("proc_pidinfo-before", errno ? errno : ESRCH); putchar('}'); return;
    }
    printf(",\"parentPid\":%u,\"uid\":%u,\"startWallSec\":\"%" PRIu64 "\",\"startWallUsec\":\"%" PRIu64 "\"",
        before.pbi_ppid, before.pbi_uid, before.pbi_start_tvsec, before.pbi_start_tvusec);
    if (before.pbi_uid != getuid()) {
        error_field("current-user-only", EACCES); putchar('}'); return;
    }
    errno = 0;
    if (proc_pid_rusage(pid, RUSAGE_INFO_V4, (rusage_info_t *)&usage) != 0) {
        error_field("proc_pid_rusage", errno); putchar('}'); return;
    }
    char path[PROC_PIDPATHINFO_MAXSIZE] = {0};
    int path_result = proc_pidpath(pid, path, sizeof(path));
    errno = 0;
    pid_t responsibility = responsible ? responsible(pid) : -1;
    int responsibility_error = errno;
    errno = 0;
    if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &after, sizeof(after)) != sizeof(after)) {
        error_field("proc_pidinfo-after", errno ? errno : ESRCH); putchar('}'); return;
    }
    if (before.pbi_start_tvsec != after.pbi_start_tvsec || before.pbi_start_tvusec != after.pbi_start_tvusec || before.pbi_uid != after.pbi_uid) {
        error_field("pid-identity-changed", ESRCH); putchar('}'); return;
    }
    if (usage.ri_proc_exit_abstime != 0) {
        error_field("process-exited", ESRCH); putchar('}'); return;
    }
    printf(",\"physFootprintBytes\":%" PRIu64 ",\"residentBytes\":%" PRIu64 ",\"lifetimeMaxPhysFootprintBytes\":%" PRIu64 ",\"startTime\":\"%" PRIu64 "\"",
        usage.ri_phys_footprint, usage.ri_resident_size, usage.ri_lifetime_max_phys_footprint, usage.ri_proc_start_abstime);
    printf(",\"executablePath\":"); if (path_result > 0) json_string(path); else printf("null");
    printf(",\"responsiblePid\":"); if (responsibility > 0) printf("%d", responsibility); else printf("null");
    if (responsible && responsibility <= 0) printf(",\"responsibilityErrno\":%d", responsibility_error);
    putchar('}');
}

int main(int argc, char **argv) {
    if (argc < 2 || argc > 4097) { fprintf(stderr, "Usage: memory-probe PID [PID ...] (max4096)\n"); return 2; }
    pid_t pids[4096];
    for (int i = 1; i < argc; ++i) {
        if (strcmp(argv[i], "self") == 0) { pids[i-1] = getpid(); continue; }
        char *end = NULL; errno = 0; long value = strtol(argv[i], &end, 10);
        if (errno || !end || *end || value < 1 || value > INT_MAX) { fprintf(stderr, "Invalid PID\n"); return 2; }
        pids[i-1] = (pid_t)value;
    }
    pid_t (*responsible)(pid_t) = (pid_t (*)(pid_t))dlsym(RTLD_DEFAULT, "responsibility_get_pid_responsible_for_pid");
    putchar('[');
    for (int i = 1; i < argc; ++i) { if (i > 1) putchar(','); sample(pids[i-1], responsible); }
    puts("]"); return 0;
}

/* Nonshipping task127 observer, compiled before workloads. No SQLite API, database
 * write, recovery or lock acquisition. Use native headers for fcntl's variadic ABI.
 * https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/fcntl.2.html
 */
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

static double clock_ms(clockid_t clock_id) {
  struct timespec value;
  if (clock_gettime(clock_id, &value) != 0) return -1.0;
  return (double)value.tv_sec * 1000.0 + (double)value.tv_nsec / 1000000.0;
}

int main(int argc, char **argv) {
  double started = clock_ms(CLOCK_REALTIME), monotonic_started = clock_ms(CLOCK_MONOTONIC);
  struct stat named = {0}, held = {0}, after = {0};
  struct flock conflicts[2];
  const short queries[2] = {F_RDLCK, F_WRLCK};
  int fd = -1, saved_errno = 0, count = 0, have_identity = 0, unchanged = 0;
  const char *stage = "arguments", *error = NULL;
  if (argc != 2) { saved_errno = EINVAL; error = "probe-arguments"; goto report; }
  stage = "lstat";
  if (lstat(argv[1], &named) != 0) { saved_errno = errno; error = "probe-lstat"; goto report; }
  have_identity = 1;
  if (!S_ISREG(named.st_mode)) { saved_errno = EINVAL; error = "unsafe-cursor-type"; goto report; }
  stage = "open-readonly";
  fd = open(argv[1], O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  if (fd < 0) { saved_errno = errno; error = "probe-open"; goto report; }
  stage = "fstat";
  if (fstat(fd, &held) != 0) { saved_errno = errno; error = "probe-fstat"; goto report; }
  if (!S_ISREG(held.st_mode) || named.st_dev != held.st_dev || named.st_ino != held.st_ino) {
    saved_errno = EAGAIN; error = "cursor-identity-changed"; goto report;
  }
  /* ponytail: whole-file READ/WRITE queries each expose only their first conflict.
   * Upgrade to source-pinned SQLite byte ranges if attribution requires more coverage. */
  for (int index = 0; index < 2; index++) {
    struct flock description;
    memset(&description, 0, sizeof(description));
    description.l_type = queries[index];
    description.l_whence = SEEK_SET;
    description.l_start = 0;
    description.l_len = 0;
    stage = index == 0 ? "getlk-read" : "getlk-write";
    if (fcntl(fd, F_GETLK, &description) != 0) { saved_errno = errno; error = "getlk-failed"; goto report; }
    if (description.l_type != F_UNLCK) {
      if ((description.l_type != F_RDLCK && description.l_type != F_WRLCK) || description.l_whence != SEEK_SET ||
          description.l_start < 0 || description.l_len < 0 ||
          (description.l_len > 0 && (uintmax_t)description.l_start > UINTMAX_MAX - (uintmax_t)description.l_len + 1)) {
        saved_errno = EINVAL; error = "getlk-record-invalid"; goto report;
      }
      conflicts[count++] = description;
    }
  }
  stage = "identity-after";
  if (lstat(argv[1], &after) != 0) { saved_errno = errno; error = "probe-lstat-after"; goto report; }
  unchanged = named.st_dev == after.st_dev && named.st_ino == after.st_ino && S_ISREG(after.st_mode);
  if (!unchanged) { saved_errno = EAGAIN; error = "cursor-identity-changed"; goto report; }
  stage = "complete";
report:
  if (fd >= 0 && close(fd) != 0 && error == NULL) { saved_errno = errno; stage = "close"; error = "probe-close"; }
  double finished = clock_ms(CLOCK_REALTIME), monotonic_finished = clock_ms(CLOCK_MONOTONIC);
  if ((started < 0 || finished < 0 || monotonic_started < 0 || monotonic_finished < 0) && error == NULL) {
    saved_errno = EIO; stage = "clock"; error = "probe-clock";
  }
  printf("{\"available\":%s,\"observerPid\":%jd,\"startedMs\":%.3f,\"finishedMs\":%.3f,"
         "\"monotonicStartedMs\":%.3f,\"monotonicFinishedMs\":%.3f,\"clock\":\"clock-realtime-ms\","
         "\"stage\":\"%s\",\"errno\":%d,\"fileIdentityUnchanged\":%s",
         error == NULL ? "true" : "false", (intmax_t)getpid(), started, finished,
         monotonic_started, monotonic_finished, stage, saved_errno, unchanged ? "true" : "false");
  if (error != NULL) printf(",\"error\":\"%s\"", error);
  if (have_identity) printf(",\"file\":{\"dev\":\"%ju\",\"ino\":\"%ju\",\"nlink\":\"%ju\",\"size\":\"%jd\"}",
                            (uintmax_t)named.st_dev, (uintmax_t)named.st_ino, (uintmax_t)named.st_nlink, (intmax_t)named.st_size);
  printf(",\"locks\":[");
  for (int index = 0; index < count; index++) {
    const struct flock *value = &conflicts[index];
    printf("%s{\"source\":\"darwin-f-getlk\",\"type\":\"POSIX\",\"mode\":\"%s\",\"pid\":%jd,\"start\":\"%ju\",\"end\":\"",
           index ? "," : "", value->l_type == F_RDLCK ? "READ" : "WRITE", (intmax_t)value->l_pid, (uintmax_t)value->l_start);
    if (value->l_len == 0) printf("EOF");
    else printf("%ju", (uintmax_t)value->l_start + (uintmax_t)value->l_len - 1);
    printf("\",\"blocked\":false}");
  }
  printf("]}\n");
  return 0;
}

#!/usr/bin/perl
# Run a sandboxed command on pipes this relay owns, and copy its output to the relay's own stdout
# and stderr (the worker's pipes). The command never receives the worker's descriptors.
#
# Why: a sandboxed process can keep its stdout alive after every one of its processes is gone, for
# example by parking the descriptor in a garbage cycle of SCM_RIGHTS messages that the kernel only
# frees at its next UNIX-socket garbage collection, seconds later. If that descriptor were the
# worker's pipe, the worker would wait on it and declare the command's teardown unverified. With the
# relay, a parked descriptor is the relay's inner pipe. Once the command's direct child (bwrap, or
# landrun) has exited, nothing in the sandbox can write any more: the relay reads what is already
# buffered until a read would block, then exits, and the worker's pipes close with it.
#
# Usage: stdio-relay.pl COMMAND [ARGS...]
# Exit status: the command's, or 128+signal when a signal ended it (127 if it cannot be started).
# TERM, INT and HUP are forwarded to the command as TERM. As a PID namespace's init the relay also
# reaps orphans. Inherited descriptors other than stdio (bwrap's --seccomp descriptor) pass to the
# command; the relay closes its own copy of descriptor 9 once the command has started.
#
# Uses only perl-base (Essential on Debian), so every worker image has it.
use strict;
use warnings;
use Errno qw(EAGAIN EINTR EWOULDBLOCK);
use Fcntl qw(F_GETFL F_SETFL O_NONBLOCK);
use IO::Select;
use POSIX qw(:sys_wait_h);

die "usage: stdio-relay.pl COMMAND [ARGS...]\n" unless @ARGV;
# After the command exits, at most this long is spent reading what it left in the pipes.
my $drain_ms = ($ENV{DOCSLURP_STDIO_RELAY_DRAIN_MS} // '') =~ /^\d+$/ ? $ENV{DOCSLURP_STDIO_RELAY_DRAIN_MS} : 5000;

pipe(my $out_r, my $out_w) or die "stdio-relay: pipe: $!\n";
pipe(my $err_r, my $err_w) or die "stdio-relay: pipe: $!\n";

my $child = fork();
die "stdio-relay: fork: $!\n" unless defined $child;
if ($child == 0) {
  POSIX::dup2(fileno($out_w), 1) or POSIX::_exit(127);
  POSIX::dup2(fileno($err_w), 2) or POSIX::_exit(127);
  # perl opened these four close-on-exec; dup2'd 1 and 2 are not.
  { no warnings 'exec'; exec { $ARGV[0] } @ARGV; }
  print STDERR "stdio-relay: cannot run $ARGV[0]: $!\n";
  POSIX::_exit(127);
}
close($out_w);
close($err_w);
POSIX::close(9);

my $status;
my $stop = sub { kill('TERM', $child) if !defined $status };
$SIG{TERM} = $stop;
$SIG{INT} = $stop;
$SIG{HUP} = $stop;
# Any handler (not IGNORE): select() is then interrupted when a child exits.
$SIG{CHLD} = sub {};
$SIG{PIPE} = 'IGNORE';

binmode(STDOUT);
binmode(STDERR);
my %sink = (fileno($out_r) => \*STDOUT, fileno($err_r) => \*STDERR);
my $select = IO::Select->new($out_r, $err_r);

sub reap {
  while ((my $pid = waitpid(-1, WNOHANG)) > 0) {
    next unless $pid == $child;
    $status = WIFEXITED($?) ? WEXITSTATUS($?) : WIFSIGNALED($?) ? 128 + WTERMSIG($?) : 1;
  }
}

sub write_all {
  my ($fh, $buffer) = @_;
  my $offset = 0;
  while ($offset < length($buffer)) {
    my $written = syswrite($fh, $buffer, length($buffer) - $offset, $offset);
    if (!defined $written) {
      next if $! == EINTR;
      # The worker stopped reading: keep consuming the command's output so it never blocks on it.
      return;
    }
    $offset += $written;
  }
}

# Returns false at EOF or when nothing is left to read without blocking.
sub pump {
  my ($fh) = @_;
  my $read = sysread($fh, my $buffer, 65536);
  if (!defined $read) {
    return 1 if $! == EINTR;
    return 0 if $! == EAGAIN || $! == EWOULDBLOCK;
    $select->remove($fh);
    return 0;
  }
  if ($read == 0) {
    $select->remove($fh);
    return 0;
  }
  write_all($sink{fileno($fh)}, $buffer);
  return 1;
}

# While the command runs: copy whatever is readable. A short timeout bounds the window between
# the last waitpid and select() in which a SIGCHLD could be missed.
while (!defined $status && $select->count) {
  my @ready = $select->can_read(0.25);
  pump($_) for @ready;
  reap();
}
# Both pipes reached EOF (the usual end): wait for the command itself.
while (!defined $status) {
  my $pid = waitpid($child, 0);
  if ($pid == $child) {
    $status = WIFEXITED($?) ? WEXITSTATUS($?) : WIFSIGNALED($?) ? 128 + WTERMSIG($?) : 1;
  } elsif ($pid < 0 && $! != EINTR) {
    $status = 1;
  }
}
# As a PID namespace's init (landlock), first end every process the command left behind; under
# bubblewrap, bwrap's own PID namespace is already empty once bwrap has exited. Never kill(-1)
# anywhere else: it would reach every process this user may signal.
if ($$ == 1) {
  kill('KILL', -1);
  while (waitpid(-1, 0) > 0 || $! == EINTR) {}
}
# The command has exited, and with it every process that could write. Read what is buffered until a read would block, never waiting on a descriptor the
# sandbox may have parked somewhere: that is the point of the relay.
# perl-base has no Time::HiRes: POSIX::times() counts real time in clock ticks.
my $ticks = POSIX::sysconf(POSIX::_SC_CLK_TCK()) || 100;
my $deadline = (POSIX::times())[0] + $drain_ms * $ticks / 1000;
for my $fh ($select->handles) {
  my $flags = fcntl($fh, F_GETFL, 0);
  fcntl($fh, F_SETFL, $flags | O_NONBLOCK) if defined $flags;
}
for my $fh ($select->handles) {
  while ((POSIX::times())[0] < $deadline && pump($fh)) {}
}
reap();
exit($status);

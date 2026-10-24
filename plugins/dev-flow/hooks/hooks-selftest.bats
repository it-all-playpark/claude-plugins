#!/usr/bin/env bats
# dev-flow plugin hooks の self-contained *.test.sh を run-all-bats.sh 経由で discovery
# できるようにする wrapper。各 test.sh 自体が独立した bash test harness（内部で個別 assert
# を持つ）なので、ここでは "exit 0 で完走したか" のみを pin する。

@test "pretool-inline-edit-guard.test.sh は exit 0 で完走する" {
  run bash "$BATS_TEST_DIRNAME/pretool-inline-edit-guard.test.sh"
  echo "$output"
  [ "$status" -eq 0 ]
}

@test "pretool-bash-inline-commit-gate.test.sh は exit 0 で完走する" {
  run bash "$BATS_TEST_DIRNAME/pretool-bash-inline-commit-gate.test.sh"
  echo "$output"
  [ "$status" -eq 0 ]
}

@test "pretool-bash-issue-create-guard.test.sh は exit 0 で完走する" {
  run bash "$BATS_TEST_DIRNAME/pretool-bash-issue-create-guard.test.sh"
  echo "$output"
  [ "$status" -eq 0 ]
}

@test "stop-devflow-telemetry.test.sh は exit 0 で完走する" {
  run bash "$BATS_TEST_DIRNAME/stop-devflow-telemetry.test.sh"
  echo "$output"
  [ "$status" -eq 0 ]
}

@test "pretool-security-reviewer-read-scope.test.sh は exit 0 で完走する" {
  run bash "$BATS_TEST_DIRNAME/pretool-security-reviewer-read-scope.test.sh"
  echo "$output"
  [ "$status" -eq 0 ]
}

@test "pretool-codex-invocation-guard.test.sh は exit 0 で完走する" {
  run bash "$BATS_TEST_DIRNAME/pretool-codex-invocation-guard.test.sh"
  echo "$output"
  [ "$status" -eq 0 ]
}

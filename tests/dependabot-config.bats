#!/usr/bin/env bats
# Invariant (#1431): 依存更新の PR は Dependabot だけが出す。.github/dependabot.yml は npm と
# github-actions の 2 エントリを週次（Asia/Tokyo）で持ち、commit / PR タイトルは既存の
# `chore(deps): ...` / `chore(deps-dev): ...` の形になる。
# CI の bats job には YAML parser が無い（bats + jq だけ）ので、awk で `path=value` に平坦化して照合する。

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
    DEPENDABOT_YML="$REPO_ROOT/.github/dependabot.yml"
}

# block 形式の YAML（mapping と `- ` の sequence、scalar 値）を `updates.0.schedule.interval=weekly`
# の形で 1 行ずつ出力する。コメントと空行は捨て、値の引用符は外す。
flatten() {
    awk '
        function pop_to(ind) { while (depth > 0 && indent[depth] >= ind) depth-- }
        function path(    i, p) {
            p = ""
            for (i = 1; i <= depth; i++) p = p key[i] "."
            return p
        }
        /^[[:space:]]*(#|$)/ { next }
        {
            sub(/[[:space:]]+#.*$/, "")
            match($0, /^ */)
            ind = RLENGTH
            line = substr($0, ind + 1)
            if (line ~ /^- /) {
                pop_to(ind)
                p = path()
                depth++
                indent[depth] = ind
                key[depth] = count[p]++
                line = substr(line, 3)
                ind += 2
            }
            pop_to(ind)
            k = line
            sub(/:.*$/, "", k)
            v = line
            sub(/^[^:]*:[[:space:]]*/, "", v)
            gsub(/^["\047]|["\047]$/, "", v)
            if (v == "") {
                depth++
                indent[depth] = ind
                key[depth] = k
            } else {
                print path() k "=" v
            }
        }
    ' "$DEPENDABOT_YML"
}

# flatten の出力のうち ERE に一致する行だけを出力する。
flat_lines() {
    flatten | grep -E -- "$1"
}

@test "dependabot.yml は version 2 で、updates は npm と github-actions（どちらも directory /）の 2 エントリだけ" {
    run flat_lines '^(version|updates\.[0-9]+\.(package-ecosystem|directory))='
    echo "$output"
    [ "$status" -eq 0 ]
    [ "$output" = "version=2
updates.0.package-ecosystem=npm
updates.0.directory=/
updates.1.package-ecosystem=github-actions
updates.1.directory=/" ]
}

@test "dependabot.yml の全エントリは週次・Asia/Tokyo で更新を出す" {
    run flat_lines '^updates\.[0-9]+\.schedule\.'
    echo "$output"
    [ "$status" -eq 0 ]
    [ "$output" = "updates.0.schedule.interval=weekly
updates.0.schedule.timezone=Asia/Tokyo
updates.1.schedule.interval=weekly
updates.1.schedule.timezone=Asia/Tokyo" ]
}

@test "dependabot.yml の全エントリは commit-message を prefix chore + scope にする（chore(deps): ... の形）" {
    run flat_lines '^updates\.[0-9]+\.commit-message\.'
    echo "$output"
    [ "$status" -eq 0 ]
    [ "$output" = "updates.0.commit-message.prefix=chore
updates.0.commit-message.include=scope
updates.1.commit-message.prefix=chore
updates.1.commit-message.include=scope" ]
}

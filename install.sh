#!/usr/bin/env bash
set -euo pipefail

if ! command -v pkg >/dev/null 2>&1 || [[ ${PREFIX:-} != */com.termux/files/usr ]]; then
    echo '此脚本用于 Android Termux；Windows 请运行 install.ps1。' >&2
    exit 1
fi
st=${1:-}
if [[ -z $st ]]; then
    read -r -p "酒馆目录 [${HOME}/SillyTavern]（先关闭酒馆）: " st
    st=${st:-"$HOME/SillyTavern"}
fi
[[ -f "$st/config.yaml" ]] || { echo '未找到 config.yaml，请先完成酒馆首次启动。' >&2; exit 1; }
case "$(cd -- "$st" && pwd -P)" in /sdcard/*|/storage/*) echo '酒馆必须放在 Termux 私有 HOME 中。' >&2; exit 1 ;; esac
st=$(cd -- "$st" && pwd -P)
packages=(git rsync openssh)
if ! command -v node >/dev/null 2>&1 || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)'; then
    packages+=(nodejs-lts)
fi
pkg install -y "${packages[@]}"
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
repository=$(node -e 'console.log(require("node:path").resolve(process.argv[1]))' "${TAVERNSYN_REPOSITORY:-"$st/plugins/tavernsyn"}")
[[ $repository == "$st/plugins/tavernsyn" ]] || { echo '代码统一安装到酒馆的 plugins/tavernsyn，请取消自定义 TAVERNSYN_REPOSITORY。' >&2; exit 1; }
if [[ ! -f "$source_dir/bin/setup-device.mjs" ]]; then
    source_dir=$repository
    if [[ -e $source_dir && ! -f "$source_dir/bin/setup-device.mjs" ]]; then
        source_dir="$st/.tavernsyn-download-$(node -e 'console.log(require("node:crypto").randomUUID())')"
    fi
    if [[ ! -e $source_dir ]]; then
        git clone --depth 1 --branch main https://github.com/anyKami/tavernSyn.git "$source_dir"
    fi
    [[ -f "$source_dir/bin/setup-device.mjs" ]] || { echo '仓库缺少安装器，请先更新酒馆 plugins/tavernsyn 中的代码。' >&2; exit 1; }
    printf '使用仓库：%s（已有仓库请先自行 git pull 更新）\n' "$source_dir"
fi
arguments=(--st "$st" --repository "$repository")
[[ -z ${2:-} ]] || arguments+=(--state "$2")
[[ -z ${3:-} ]] || arguments+=(--profile "$3")
exec node "$source_dir/bin/setup-device.mjs" "${arguments[@]}"

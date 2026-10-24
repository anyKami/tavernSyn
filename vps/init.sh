#!/usr/bin/env bash
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
sync_user=${1:-tavernsyn}
store_root=${2:-/srv/tavernsyn}
dataset=${3:-$(python3 -c 'import uuid; print(uuid.uuid4())')}
[[ $(id -u) == 0 ]] || { echo '请以管理员运行初始化。' >&2; exit 1; }
[[ $sync_user =~ ^[a-z_][a-z0-9_-]{0,30}$ && $sync_user != root ]] || exit 1
[[ $store_root =~ ^/(srv|var/lib)/[a-zA-Z0-9_./-]+$ && $store_root != *..* ]] || exit 1
[[ $dataset =~ ^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$ ]] || { echo '第三个参数应为新数据集 UUID。' >&2; exit 1; }
[[ ! -e $store_root ]] || { echo '存储目录必须全新；不会复用旧酒馆目录。' >&2; exit 1; }
! id "$sync_user" >/dev/null 2>&1 || { echo '请使用新的专用同步账号。' >&2; exit 1; }
for tool in python3 rsync sshd cp passwd; do command -v "$tool" >/dev/null || { echo "缺少 $tool；先安装 python3 rsync openssh-server coreutils。" >&2; exit 1; }; done
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
python3 "$script_dir/dispatcher.py" --root "$store_root" --init "$dataset"
useradd --system --create-home --home-dir "/var/lib/$sync_user" --shell /bin/sh "$sync_user"
chown -R -- "$sync_user:$sync_user" "$store_root"
chmod 700 -- "$store_root"
chown root:root "/var/lib/$sync_user"
chmod 755 "/var/lib/$sync_user"
bash "$script_dir/enable-password.sh" "$sync_user" "$store_root"
printf '已初始化独立数据集：%s\n专用账号：%s\n在酒馆中填写 VPS 地址、上述账号和刚设置的密码即可，数据集自动读取。\n' "$dataset" "$sync_user"

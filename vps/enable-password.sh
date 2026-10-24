#!/usr/bin/env bash
# Enable password sync for a new or existing dedicated TavernSyn account.
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
sync_user=${1:-tavernsyn}
store_root=${2:-/srv/tavernsyn}
password_mode=${3:-}
[[ -z $password_mode || $password_mode == --keep-password ]] || { echo '第三个参数仅支持 --keep-password。' >&2; exit 1; }
[[ $(id -u) == 0 && $sync_user =~ ^[a-z_][a-z0-9_-]{0,30}$ && $sync_user != root ]] || exit 1
[[ $store_root =~ ^/(srv|var/lib)/[a-zA-Z0-9_./-]+$ && $store_root != *..* ]] || exit 1
[[ -d $store_root && ! -L $store_root && -f $store_root/FORMAT.json ]] || exit 1
[[ $(stat -c %U "$store_root") == "$sync_user" && $(id -u "$sync_user") != 0 ]] || exit 1
if [[ $password_mode == --keep-password ]]; then
    [[ $(passwd -S "$sync_user" | awk '{print $2}') == P ]] || { echo '同步账号尚未设置可用密码；请省略 --keep-password 以设置密码。' >&2; exit 1; }
fi
python3 - "$store_root" <<'PY'
import json, pathlib, re, sys
root = pathlib.Path(sys.argv[1])
assert root.resolve() == root
value = json.loads((root / 'FORMAT.json').read_text())
assert value.get('format') == 1 and re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', value.get('dataset', ''))
PY
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
install -d -o root -g root -m 755 /usr/local/libexec/tavernsyn /etc/ssh/tavernsyn
install -o root -g root -m 755 "$script_dir/dispatcher.py" /usr/local/libexec/tavernsyn/password-dispatcher.py
config=/etc/ssh/sshd_config
snippet="/etc/ssh/tavernsyn/$sync_user.conf"
[[ -f $config && ! -L $config && ! -L $snippet ]] || exit 1
backup=$(mktemp -d /etc/ssh/.tavernsyn-config.XXXXXX)
cp -p -- "$config" "$backup/sshd_config"
if [[ -e $snippet ]]; then cp -p -- "$snippet" "$backup/account.conf"; fi
rollback() {
    cp -p -- "$backup/sshd_config" "$config"
    if [[ -e $backup/account.conf ]]; then cp -p -- "$backup/account.conf" "$snippet"; else rm -f -- "$snippet"; fi
    rm -f -- "$backup/sshd_config" "$backup/account.conf"
    rmdir -- "$backup"
    echo '未启用密码同步，SSH 配置已恢复。' >&2
}
trap rollback ERR
cat > "$snippet" <<EOF
Match User $sync_user
    ClientAliveInterval 15
    ClientAliveCountMax 3
    AuthenticationMethods password
    PasswordAuthentication yes
    PubkeyAuthentication no
    KbdInteractiveAuthentication no
    PermitEmptyPasswords no
    DisableForwarding yes
    PermitTTY no
    PermitUserRC no
    ForceCommand /usr/bin/python3 /usr/local/libexec/tavernsyn/password-dispatcher.py --root $store_root
Match User $sync_user Address *,!100.64.0.0/10,!fd7a:115c:a1e0::/48
    DenyUsers *
Match all
EOF
chmod 600 -- "$snippet"
# Match blocks must follow global-only directives (Port, UsePAM, Subsystem, etc.).
python3 - "$config" <<'PY'
from pathlib import Path
import sys
file = Path(sys.argv[1])
text = file.read_text()
include = 'Include /etc/ssh/tavernsyn/*.conf'
lines = [line for line in text.splitlines() if line.strip() != include]
file.write_text('\n'.join(lines) + '\n\nMatch all\n' + include + '\n')
PY
sshd -t
effective=$(sshd -T -C "user=$sync_user,host=tavernsyn-client,addr=100.64.0.1,laddr=100.64.0.2,lport=22")
grep -ixq 'passwordauthentication yes' <<< "$effective"
grep -ixq 'authenticationmethods password' <<< "$effective"
grep -ixq 'pubkeyauthentication no' <<< "$effective"
grep -ixq 'disableforwarding yes' <<< "$effective"
grep -Fxiq "forcecommand /usr/bin/python3 /usr/local/libexec/tavernsyn/password-dispatcher.py --root $store_root" <<< "$effective"
outside=$(sshd -T -C "user=$sync_user,host=outside,addr=203.0.113.1,laddr=203.0.113.2,lport=22")
grep -ixq 'denyusers \*' <<< "$outside"
if [[ $password_mode == --keep-password ]]; then
    printf '保留 %s 账号现有密码。\n' "$sync_user"
else
    printf '请设置 %s 账号的同步密码（输入时不会显示）：\n' "$sync_user"
    passwd "$sync_user"
fi
if command -v systemctl >/dev/null && systemctl is-active --quiet ssh; then systemctl reload ssh
elif command -v systemctl >/dev/null && systemctl is-active --quiet sshd; then systemctl reload sshd
elif command -v service >/dev/null; then service ssh reload
else echo '无法重载 SSH 服务。' >&2; false
fi
trap - ERR
rm -f -- "$backup/sshd_config" "$backup/account.conf"
rmdir -- "$backup"
printf '已启用 %s 密码同步，仅允许 Tailscale 来源和固定同步命令。\n' "$sync_user"

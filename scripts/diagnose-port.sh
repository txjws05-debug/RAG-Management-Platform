#!/usr/bin/env bash
# 诊断 8080（或指定端口）到底被哪一层挡住。
#
# 在服务器上执行： bash scripts/diagnose-port.sh 8080
# 只读脚本，不修改任何配置。
set -uo pipefail

PORT="${1:-8080}"

line() { printf '\n\033[36m===== %s =====\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }

line "0. 身份与系统"
note "当前用户 : $(id -un) (uid=$(id -u))"
if [[ "$(id -u)" -eq 0 ]]; then
  note "是否 root: 是"
else
  note "是否 root: 否 —— ufw/iptables 的修改需要 sudo 或 root"
  if command -v sudo >/dev/null 2>&1; then
    if sudo -n true 2>/dev/null; then
      note "免密 sudo: 可用"
    else
      note "免密 sudo: 不可用（执行时需要输入密码）"
    fi
  else
    note "sudo     : 未安装"
  fi
fi
if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  note "发行版   : ${PRETTY_NAME:-unknown}"
fi
if command -v systemd-detect-virt >/dev/null 2>&1; then
  note "虚拟化   : $(systemd-detect-virt 2>/dev/null || echo unknown)"
fi
if command -v curl >/dev/null 2>&1; then
  note "公网 IP  : $(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || echo '(取不到，可能无外网或需代理)')"
fi

line "1. 端口此刻有没有进程在监听"
if command -v ss >/dev/null 2>&1; then
  ss -lntp 2>/dev/null | grep -E ":${PORT}\b" || note "没有任何进程监听 ${PORT}"
elif command -v netstat >/dev/null 2>&1; then
  netstat -lntp 2>/dev/null | grep -E ":${PORT}\b" || note "没有任何进程监听 ${PORT}"
else
  note "ss 与 netstat 都没有，装一个：apt install -y iproute2"
fi
note "提示：Docker 发布端口时监听的是 0.0.0.0 或 [::]，若只看到 127.0.0.1 说明只绑了本机"

line "2. 防火墙（ufw / firewalld / iptables 三选一）"
if command -v ufw >/dev/null 2>&1; then
  note "ufw: 已安装"
  ufw status verbose 2>&1 | sed 's/^/    /'
else
  note "ufw: 未安装"
fi
if command -v firewall-cmd >/dev/null 2>&1; then
  note "firewalld: 已安装 —— 运行中? $(systemctl is-active firewalld 2>/dev/null || echo unknown)"
  firewall-cmd --list-ports 2>/dev/null | sed 's/^/    已放行端口: /'
  firewall-cmd --list-services 2>/dev/null | sed 's/^/    已放行服务: /'
else
  note "firewalld: 未安装"
fi
note "iptables 现有规则（只看 INPUT 与 DOCKER 相关）："
if command -v iptables >/dev/null 2>&1; then
  iptables -S 2>/dev/null | grep -E '^-P INPUT|--dport '"${PORT}"'|DOCKER' | sed 's/^/    /' || note "    （读不到规则，可能权限不足）"
else
  note "    iptables 未安装"
fi

line "3. Docker 的端口发布情况"
if command -v docker >/dev/null 2>&1; then
  docker ps --format '{{.Names}}\t{{.Ports}}' 2>/dev/null | sed 's/^/    /' || note "    docker ps 失败（权限？）"
else
  note "docker 未安装"
fi

line "4. 云厂商安全组"
note "这一层在服务器**内部看不到**，必须去云控制台确认。"
note "常见厂商入口："
note "  阿里云 ：ECS → 安全组 → 配置规则 → 入方向 → 添加 ${PORT}"
note "  腾讯云 ：轻量应用服务器 → 防火墙 / CVM → 安全组"
note "  华为云 ：ECS → 安全组 → 入方向规则"
note "  AWS    ：EC2 → Security Groups → Inbound rules"
note "  甲骨文 ：VCN → Security Lists / NSG"
note "  宝塔面板：若装了宝塔，它自身也有防火墙页面，需单独放行"

line "5. 结论速查"
note "若第 1 步没有监听        → 先启动服务，与防火墙无关"
note "若第 2 步 ufw 未安装且第 4 步未放行 → 直接在云控制台放行即可，不用装 ufw"
note "若第 2 步 ufw 已启用但没放行 ${PORT} → 需要 sudo ufw allow ${PORT}/tcp"
note "若第 2 步已放行但外网仍不通 → 问题在云安全组（第 4 步）"
note "若你是非 root 且无免密 sudo  → 要么用 root，要么请云厂商/管理员代开"
echo

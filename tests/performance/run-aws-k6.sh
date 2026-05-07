#!/usr/bin/env bash
set -euo pipefail

AWS_PROFILE_NAME="${AWS_PROFILE_NAME:-salijang}"
AWS_REGION="${AWS_REGION:-ap-northeast-2}"
K6_RUNNER_INSTANCE_ID="${K6_RUNNER_INSTANCE_ID:-i-04a0a7d028c6b9156}"
K6_BASE_URL_DEFAULT="${K6_BASE_URL:-https://api.sallijang.shop}"
RUNNER_SCRIPT="${RUNNER_SCRIPT:-/opt/sallijang/run-k6.sh}"

usage() {
  cat <<'USAGE'
Usage:
  tests/performance/run-aws-k6.sh
  tests/performance/run-aws-k6.sh interactive
  tests/performance/run-aws-k6.sh <scenario> [options]

Scenarios:
  smoke       기본 smoke
  read        상품 목록 조회 고정 RPS
  step        상품 목록 조회 단계 상승
  spike       상품 목록 조회 spike
  order       주문 생성 부하
  create      상품 생성/삭제 부하
  remaining   상품 재고 변경 부하
  soak        구매자 여정 soak

Common options:
  --run-id <id>             결과 디렉토리 이름
  --base-url <url>          기본값: https://api.sallijang.shop
  --instance-id <id>        기본값: i-04a0a7d028c6b9156
  --profile <name>          기본값: salijang
  --region <region>         기본값: ap-northeast-2
  --env KEY=VALUE           임의 k6 환경변수 추가. 여러 번 사용 가능
  --wait                    완료까지 기다리고 stdout/stderr 출력

Read options:
  --rate <rps>              read/order/create/remaining RPS
  --duration <duration>     read/order/create/remaining/soak duration

Step options:
  --targets <csv>           예: 5,10,20
  --hold <duration>         예: 1m
  --ramp <duration>         예: 30s

Spike options:
  --base-rate <rps>
  --spike-rate <rps>

Write/order options:
  --store-id <id>
  --seller-token <token>
  --buyer-token <token>
  --token <token>

Examples:
  tests/performance/run-aws-k6.sh smoke --wait
  tests/performance/run-aws-k6.sh read --rate 5 --duration 1m --run-id read-5rps --wait
  tests/performance/run-aws-k6.sh step --targets 5,10,20 --hold 1m --run-id step-5-20
  tests/performance/run-aws-k6.sh order --store-id 1 --rate 2 --duration 1m --buyer-token "$K6_BUYER_ACCESS_TOKEN"

Environment overrides:
  AWS_PROFILE_NAME, AWS_REGION, K6_RUNNER_INSTANCE_ID, K6_BASE_URL, RUNNER_SCRIPT
USAGE
}

die() {
  echo "error: $*" >&2
  exit 1
}

shell_quote() {
  printf '%q' "$1"
}

json_escape() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\n'/\\n}"
  printf '%s' "$value"
}

prompt_default() {
  local prompt="$1"
  local default_value="$2"
  local value
  read -r -p "$prompt [$default_value]: " value
  printf '%s' "${value:-$default_value}"
}

prompt_secret_optional() {
  local prompt="$1"
  local value
  read -r -s -p "$prompt: " value
  echo >&2
  printf '%s' "$value"
}

confirm_default_yes() {
  local prompt="$1"
  local value
  if ! read -r -p "$prompt [Y/n]: " value; then
    return 1
  fi
  [[ -z "$value" || "$value" =~ ^[Yy]$ || "$value" =~ ^[Yy][Ee][Ss]$ ]]
}

append_if_set() {
  local -n target_array="$1"
  local option_name="$2"
  local option_value="$3"
  if [[ -n "$option_value" ]]; then
    target_array+=("$option_name" "$option_value")
  fi
}

interactive_mode() {
  cat <<'MENU'
Available scenarios:
  1) smoke      기본 연결 확인
  2) read       상품 목록 조회 고정 RPS
  3) step       상품 목록 조회 단계 상승
  4) spike      순간 트래픽 급증
  5) order      주문 생성 부하
  6) create     상품 생성/삭제 부하
  7) remaining  상품 재고 변경 부하
  8) soak       구매자 여정 장시간 테스트
MENU

  local choice selected
  read -r -p "Select scenario [1-8]: " choice
  case "$choice" in
    1|smoke) selected="smoke" ;;
    2|read) selected="read" ;;
    3|step) selected="step" ;;
    4|spike) selected="spike" ;;
    5|order) selected="order" ;;
    6|create) selected="create" ;;
    7|remaining) selected="remaining" ;;
    8|soak) selected="soak" ;;
    *) die "invalid scenario selection: $choice" ;;
  esac

  local -a args
  args=("$selected")

  local base_url instance_id profile region run_id wait_answer
  profile="$(prompt_default "AWS profile" "$AWS_PROFILE_NAME")"
  region="$(prompt_default "AWS region" "$AWS_REGION")"
  instance_id="$(prompt_default "Runner instance id" "$K6_RUNNER_INSTANCE_ID")"
  base_url="$(prompt_default "K6 base URL" "$K6_BASE_URL_DEFAULT")"
  run_id="$(prompt_default "Run ID" "${selected}-$(date +%Y%m%d-%H%M%S)")"

  args+=("--profile" "$profile")
  args+=("--region" "$region")
  args+=("--instance-id" "$instance_id")
  args+=("--base-url" "$base_url")
  args+=("--run-id" "$run_id")

  case "$selected" in
    read)
      args+=("--rate" "$(prompt_default "Read RPS" "5")")
      args+=("--duration" "$(prompt_default "Duration" "1m")")
      ;;
    step)
      args+=("--targets" "$(prompt_default "Step targets CSV" "5,10,20")")
      args+=("--ramp" "$(prompt_default "Ramp duration" "30s")")
      args+=("--hold" "$(prompt_default "Hold duration per step" "1m")")
      ;;
    spike)
      args+=("--base-rate" "$(prompt_default "Base RPS" "2")")
      args+=("--spike-rate" "$(prompt_default "Spike RPS" "15")")
      ;;
    order)
      echo "주의: order 테스트는 실제 주문 데이터를 만들 수 있다." >&2
      confirm_default_yes "Continue with order test?" || exit 0
      args+=("--store-id" "$(prompt_default "Store ID" "1")")
      args+=("--rate" "$(prompt_default "Order RPS" "2")")
      args+=("--duration" "$(prompt_default "Duration" "1m")")
      append_if_set args "--buyer-token" "$(prompt_secret_optional "Buyer access token, blank to skip")"
      ;;
    create)
      echo "주의: create 테스트는 실제 상품 생성/삭제 API를 호출한다." >&2
      confirm_default_yes "Continue with product create test?" || exit 0
      args+=("--store-id" "$(prompt_default "Store ID" "1")")
      args+=("--rate" "$(prompt_default "Create RPS" "2")")
      args+=("--duration" "$(prompt_default "Duration" "1m")")
      append_if_set args "--seller-token" "$(prompt_secret_optional "Seller access token, blank to skip")"
      ;;
    remaining)
      echo "주의: remaining 테스트는 상품 재고 변경 API를 호출한다." >&2
      confirm_default_yes "Continue with remaining test?" || exit 0
      args+=("--store-id" "$(prompt_default "Store ID" "1")")
      args+=("--rate" "$(prompt_default "Remaining update RPS" "2")")
      args+=("--duration" "$(prompt_default "Duration" "1m")")
      append_if_set args "--seller-token" "$(prompt_secret_optional "Seller access token, blank to skip")"
      append_if_set args "--env" "K6_PRODUCT_POOL_SIZE=$(prompt_default "Product pool size" "10")"
      ;;
    soak)
      echo "주의: soak 테스트는 장시간 실행되며 설정에 따라 주문 데이터를 만들 수 있다." >&2
      confirm_default_yes "Continue with soak test?" || exit 0
      args+=("--store-id" "$(prompt_default "Store ID" "1")")
      args+=("--duration" "$(prompt_default "Soak duration" "10m")")
      append_if_set args "--env" "K6_SOAK_VUS=$(prompt_default "Soak VUs" "2")"
      append_if_set args "--env" "K6_SOAK_ORDER_PROBABILITY=$(prompt_default "Order probability 0-1" "0.2")"
      append_if_set args "--buyer-token" "$(prompt_secret_optional "Buyer access token, blank to skip")"
      ;;
  esac

  wait_answer="$(prompt_default "Wait for completion? y/n" "y")"
  if [[ "$wait_answer" =~ ^[Yy]$ || "$wait_answer" =~ ^[Yy][Ee][Ss]$ ]]; then
    args+=("--wait")
  fi

  echo
  echo "Selected scenario: $selected"
  echo "Run ID: $run_id"
  confirm_default_yes "Execute now?" || exit 0
  echo "Starting scenario: $selected"
  exec "$0" "${args[@]}"
}

scenario="${1:-}"
if [[ "$scenario" == "-h" || "$scenario" == "--help" ]]; then
  usage
  exit 0
fi
if [[ -z "$scenario" || "$scenario" == "interactive" ]]; then
  interactive_mode
fi
shift

scenario_file=""
declare -a env_pairs
wait_for_result=0
run_id=""

case "$scenario" in
  smoke)
    scenario_file="tests/performance/k6/sallijang/smoke.js"
    ;;
  read|product-list-load)
    scenario_file="tests/performance/k6/sallijang/product-list-load.js"
    ;;
  step|product-list-step-load)
    scenario_file="tests/performance/k6/sallijang/product-list-step-load.js"
    ;;
  spike|product-list-spike)
    scenario_file="tests/performance/k6/sallijang/product-list-spike.js"
    ;;
  order|order-create-load)
    scenario_file="tests/performance/k6/sallijang/order-create-load.js"
    ;;
  create|product-create-load)
    scenario_file="tests/performance/k6/sallijang/product-create-load.js"
    ;;
  remaining|product-remaining-load)
    scenario_file="tests/performance/k6/sallijang/product-remaining-load.js"
    ;;
  soak|buyer-journey-soak)
    scenario_file="tests/performance/k6/sallijang/buyer-journey-soak.js"
    ;;
  *)
    die "unknown scenario: $scenario"
    ;;
esac

while [[ $# -gt 0 ]]; do
  case "$1" in
    --run-id)
      run_id="${2:?missing value for --run-id}"
      shift 2
      ;;
    --base-url)
      K6_BASE_URL_DEFAULT="${2:?missing value for --base-url}"
      shift 2
      ;;
    --instance-id)
      K6_RUNNER_INSTANCE_ID="${2:?missing value for --instance-id}"
      shift 2
      ;;
    --profile)
      AWS_PROFILE_NAME="${2:?missing value for --profile}"
      shift 2
      ;;
    --region)
      AWS_REGION="${2:?missing value for --region}"
      shift 2
      ;;
    --rate)
      case "$scenario" in
        read|product-list-load) env_pairs+=("K6_READ_RATE=${2:?missing value for --rate}") ;;
        order|order-create-load) env_pairs+=("K6_ORDER_RATE=${2:?missing value for --rate}") ;;
        create|product-create-load) env_pairs+=("K6_PRODUCT_CREATE_RATE=${2:?missing value for --rate}") ;;
        remaining|product-remaining-load) env_pairs+=("K6_REMAINING_RATE=${2:?missing value for --rate}") ;;
        *) die "--rate is not supported for scenario: $scenario" ;;
      esac
      shift 2
      ;;
    --duration)
      case "$scenario" in
        read|product-list-load) env_pairs+=("K6_READ_DURATION=${2:?missing value for --duration}") ;;
        order|order-create-load) env_pairs+=("K6_ORDER_DURATION=${2:?missing value for --duration}") ;;
        create|product-create-load) env_pairs+=("K6_PRODUCT_CREATE_DURATION=${2:?missing value for --duration}") ;;
        remaining|product-remaining-load) env_pairs+=("K6_REMAINING_DURATION=${2:?missing value for --duration}") ;;
        soak|buyer-journey-soak) env_pairs+=("K6_SOAK_DURATION=${2:?missing value for --duration}") ;;
        *) die "--duration is not supported for scenario: $scenario" ;;
      esac
      shift 2
      ;;
    --targets)
      env_pairs+=("K6_STEP_TARGETS=${2:?missing value for --targets}")
      shift 2
      ;;
    --hold)
      env_pairs+=("K6_STEP_HOLD_DURATION=${2:?missing value for --hold}")
      shift 2
      ;;
    --ramp)
      env_pairs+=("K6_STEP_RAMP_DURATION=${2:?missing value for --ramp}")
      shift 2
      ;;
    --base-rate)
      env_pairs+=("K6_SPIKE_BASE_RATE=${2:?missing value for --base-rate}")
      shift 2
      ;;
    --spike-rate)
      env_pairs+=("K6_SPIKE_RATE=${2:?missing value for --spike-rate}")
      shift 2
      ;;
    --store-id)
      env_pairs+=("K6_STORE_ID=${2:?missing value for --store-id}")
      shift 2
      ;;
    --token)
      env_pairs+=("K6_ACCESS_TOKEN=${2:?missing value for --token}")
      shift 2
      ;;
    --seller-token)
      env_pairs+=("K6_SELLER_ACCESS_TOKEN=${2:?missing value for --seller-token}")
      shift 2
      ;;
    --buyer-token)
      env_pairs+=("K6_BUYER_ACCESS_TOKEN=${2:?missing value for --buyer-token}")
      shift 2
      ;;
    --env)
      [[ "${2:-}" == *=* ]] || die "--env value must be KEY=VALUE"
      env_pairs+=("$2")
      shift 2
      ;;
    --wait)
      wait_for_result=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
done

if [[ -z "$run_id" ]]; then
  run_id="${scenario}-$(date +%Y%m%d-%H%M%S)"
fi

remote_command="sudo"
remote_command+=" K6_BASE_URL=$(shell_quote "$K6_BASE_URL_DEFAULT")"
remote_command+=" SCENARIO=$(shell_quote "$scenario_file")"
remote_command+=" RUN_ID=$(shell_quote "$run_id")"
remote_command+=" K6_TESTID=$(shell_quote "$run_id")"

for pair in "${env_pairs[@]}"; do
  key="${pair%%=*}"
  value="${pair#*=}"
  [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || die "invalid env key: $key"
  remote_command+=" $key=$(shell_quote "$value")"
done

remote_command+=" $(shell_quote "$RUNNER_SCRIPT")"

params_file="$(mktemp)"
trap 'rm -f "$params_file"' EXIT
printf '{"commands":["%s"]}\n' "$(json_escape "$remote_command")" >"$params_file"

echo "scenario: $scenario_file"
echo "run id:   $run_id"
echo "runner:   $K6_RUNNER_INSTANCE_ID"
echo "command:  generated for AWS SSM"

command_id="$(
  aws ssm send-command \
    --profile "$AWS_PROFILE_NAME" \
    --region "$AWS_REGION" \
    --instance-ids "$K6_RUNNER_INSTANCE_ID" \
    --document-name AWS-RunShellScript \
    --parameters "file://$params_file" \
    --query "Command.CommandId" \
    --output text
)"

echo "ssm command id: $command_id"
echo "s3 result: s3://pickup-dev-logs/k6-results/dev/$run_id/"

if [[ "$wait_for_result" == "1" ]]; then
  echo "waiting for completion..."
  aws ssm wait command-executed \
    --profile "$AWS_PROFILE_NAME" \
    --region "$AWS_REGION" \
    --command-id "$command_id" \
    --instance-id "$K6_RUNNER_INSTANCE_ID"

  aws ssm get-command-invocation \
    --profile "$AWS_PROFILE_NAME" \
    --region "$AWS_REGION" \
    --command-id "$command_id" \
    --instance-id "$K6_RUNNER_INSTANCE_ID" \
    --query "{Status:Status,ResponseCode:ResponseCode,Stdout:StandardOutputContent,Stderr:StandardErrorContent}" \
    --output json
fi

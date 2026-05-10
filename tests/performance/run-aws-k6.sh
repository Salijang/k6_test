#!/usr/bin/env bash
set -euo pipefail

AWS_PROFILE_NAME="${AWS_PROFILE_NAME:-salijang}"
AWS_REGION="${AWS_REGION:-ap-northeast-2}"
K6_RUNNER_INSTANCE_ID="${K6_RUNNER_INSTANCE_ID:-i-04a0a7d028c6b9156}"
K6_BASE_URL_DEFAULT="${K6_BASE_URL:-https://api.sallijang.shop}"
RUNNER_SCRIPT="${RUNNER_SCRIPT:-/opt/sallijang/run-k6.sh}"

usage() {
  cat <<'USAGE'
사용법:
  ./k6aws
  ./k6aws interactive
  ./k6aws <scenario> [options]

원본 경로:
  tests/performance/run-aws-k6.sh <scenario> [options]

테스트 종류:
  smoke       기본 smoke
  read        상품 목록 조회 고정 RPS
  step        상품 목록 조회 단계 상승
  spike       상품 목록 조회 spike
  order       주문 생성 부하
  hot-order   핫 상품 주문 쏠림 부하
  create      상품 생성/삭제 부하
  remaining   상품 재고 변경 부하
  soak        구매자 여정 soak

공통 옵션:
  --run-id <id>             결과 디렉토리 이름
  --base-url <url>          기본값: https://api.sallijang.shop
  --instance-id <id>        기본값: i-04a0a7d028c6b9156
  --profile <name>          기본값: salijang
  --region <region>         기본값: ap-northeast-2
  --env KEY=VALUE           임의 k6 환경변수 추가. 여러 번 사용 가능
  --wait                    테스트 완료까지 기다린 뒤 실행 결과 출력
  --skip-runner-check       EC2/SSM 사전 상태 확인 생략

조회/쓰기 부하 옵션:
  --rate <rps>              read/order/hot-order/create/remaining RPS
  --duration <duration>     read/order/hot-order/create/remaining/soak duration

단계 상승 옵션:
  --targets <csv>           예: 5,10,20
  --hold <duration>         예: 1m
  --ramp <duration>         예: 30s

Spike 옵션:
  --base-rate <rps>
  --spike-rate <rps>

쓰기/주문 옵션:
  --store-id <id>
  --seller-token <token>
  --buyer-token <token>
  --token <token>

예시:
  ./k6aws smoke --wait
  ./k6aws read --rate 5 --duration 1m --run-id read-5rps --wait
  ./k6aws step --targets 5,10,20 --hold 1m --run-id step-5-20
  ./k6aws order --store-id 1 --rate 2 --duration 1m --buyer-token "$K6_BUYER_ACCESS_TOKEN"
  ./k6aws hot-order --store-id 1 --rate 20 --duration 2m --seller-token "$K6_SELLER_ACCESS_TOKEN" --buyer-token "$K6_BUYER_ACCESS_TOKEN"

환경변수로 기본값 변경:
  AWS_PROFILE_NAME, AWS_REGION, K6_RUNNER_INSTANCE_ID, K6_BASE_URL, RUNNER_SCRIPT
USAGE
}

die() {
  echo "오류: $*" >&2
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

json_string_value() {
  local file_path="$1"
  local key="$2"
  node -e '
const fs = require("fs");
const input = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
process.stdout.write(String(input[process.argv[2]] ?? ""));
' "$file_path" "$key"
}

extract_metric_line() {
  local text="$1"
  local metric="$2"
  printf '%s\n' "$text" | sed -n "s/^[[:space:]]*${metric}[.]*:[[:space:]]*//p" | tail -n 1
}

extract_threshold_lines() {
  local text="$1"
  printf '%s\n' "$text" | sed -n "/^[[:space:]]*█ THRESHOLDS/,/^[[:space:]]*█ TOTAL RESULTS/p" \
    | grep -E "^[[:space:]]*[✓✗]" \
    | sed "s/^[[:space:]]*/  /"
}

print_pretty_result() {
  local invocation_file="$1"
  local run_id_value="$2"
  local command_id_value="$3"
  local s3_uri="$4"

  local status response_code stdout stderr checks http_duration http_failed http_reqs iterations thresholds uploads
  status="$(json_string_value "$invocation_file" "Status")"
  response_code="$(json_string_value "$invocation_file" "ResponseCode")"
  stdout="$(json_string_value "$invocation_file" "StandardOutputContent")"
  stderr="$(json_string_value "$invocation_file" "StandardErrorContent")"

  checks="$(extract_metric_line "$stdout" "checks_succeeded")"
  http_duration="$(extract_metric_line "$stdout" "http_req_duration")"
  http_failed="$(extract_metric_line "$stdout" "http_req_failed")"
  http_reqs="$(extract_metric_line "$stdout" "http_reqs")"
  iterations="$(extract_metric_line "$stdout" "iterations")"
  thresholds="$(extract_threshold_lines "$stdout")"
  uploads="$(printf '%s\n' "$stdout" | grep -E "upload: .* to s3://" | sed "s/.* to /  /" || true)"

  echo
  echo "========== k6 테스트 결과 =========="
  echo "상태:          $status"
  echo "응답 코드:     $response_code"
  echo "Run ID:        $run_id_value"
  echo "SSM command:   $command_id_value"
  echo "S3 결과 위치:  $s3_uri"

  if [[ -n "$thresholds" ]]; then
    echo
    echo "Threshold:"
    printf '%s\n' "$thresholds"
  fi

  echo
  echo "주요 지표:"
  [[ -n "$checks" ]] && echo "  checks_succeeded: $checks"
  [[ -n "$http_duration" ]] && echo "  http_req_duration: $http_duration"
  [[ -n "$http_failed" ]] && echo "  http_req_failed:   $http_failed"
  [[ -n "$http_reqs" ]] && echo "  http_reqs:         $http_reqs"
  [[ -n "$iterations" ]] && echo "  iterations:        $iterations"

  if [[ -n "$uploads" ]]; then
    echo
    echo "업로드된 파일:"
    printf '%s\n' "$uploads"
  fi

  if [[ -n "$stderr" ]]; then
    echo
    echo "참고 로그:"
    printf '%s\n' "$stderr" | sed "s/^/  /"
  fi

  if [[ "$status" != "Success" || "$response_code" != "0" ]]; then
    echo
    echo "실패 상세 로그:"
    printf '%s\n' "$stdout" | tail -n 80 | sed "s/^/  /"
    return 1
  fi
}

check_runner_ready() {
  echo "Runner 상태 확인 중..."

  local ec2_state ssm_ping
  ec2_state="$(
    aws ec2 describe-instances \
      --profile "$AWS_PROFILE_NAME" \
      --region "$AWS_REGION" \
      --instance-ids "$K6_RUNNER_INSTANCE_ID" \
      --query "Reservations[0].Instances[0].State.Name" \
      --output text 2>/dev/null || true
  )"

  if [[ -z "$ec2_state" || "$ec2_state" == "None" ]]; then
    die "runner EC2를 찾을 수 없습니다: $K6_RUNNER_INSTANCE_ID"
  fi

  if [[ "$ec2_state" != "running" ]]; then
    cat >&2 <<MSG
오류: runner EC2가 실행 중이 아닙니다.
- instance id: $K6_RUNNER_INSTANCE_ID
- current state: $ec2_state

이 상태에서는 EC2에서 k6를 실행할 수 없습니다.
runner를 먼저 시작하거나 Terraform으로 runner를 생성한 뒤 다시 실행하세요.
MSG
    exit 1
  fi

  ssm_ping="$(
    aws ssm describe-instance-information \
      --profile "$AWS_PROFILE_NAME" \
      --region "$AWS_REGION" \
      --filters "Key=InstanceIds,Values=$K6_RUNNER_INSTANCE_ID" \
      --query "InstanceInformationList[0].PingStatus" \
      --output text 2>/dev/null || true
  )"

  if [[ "$ssm_ping" != "Online" ]]; then
    cat >&2 <<MSG
오류: runner EC2는 running 상태지만 SSM 연결이 Online이 아닙니다.
- instance id: $K6_RUNNER_INSTANCE_ID
- SSM status: ${ssm_ping:-unknown}

가능한 원인:
- EC2 부팅 직후라 SSM agent 등록이 아직 안 됨
- IAM role에 AmazonSSMManagedInstanceCore 권한 없음
- 네트워크/VPC endpoint/인터넷 egress 문제

잠시 후 다시 실행하거나 runner 상태를 확인하세요.
MSG
    exit 1
  fi

  echo "Runner 상태: EC2 running, SSM Online"
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
실행 가능한 테스트:
  1) smoke      기본 연결 확인
  2) read       상품 목록 조회 고정 RPS
  3) step       상품 목록 조회 단계 상승
  4) spike      순간 트래픽 급증
  5) order      주문 생성 부하
  6) hot-order  핫 상품 주문 쏠림 부하
  7) create     상품 생성/삭제 부하
  8) remaining  상품 재고 변경 부하
  9) soak       구매자 여정 장시간 테스트
MENU

  local choice selected
  read -r -p "테스트를 선택하세요 [1-9]: " choice
  case "$choice" in
    1|smoke) selected="smoke" ;;
    2|read) selected="read" ;;
    3|step) selected="step" ;;
    4|spike) selected="spike" ;;
    5|order) selected="order" ;;
    6|hot-order) selected="hot-order" ;;
    7|create) selected="create" ;;
    8|remaining) selected="remaining" ;;
    9|soak) selected="soak" ;;
    *) die "invalid scenario selection: $choice" ;;
  esac

  local -a args
  args=("$selected")

  local base_url instance_id profile region run_id wait_answer
  profile="$(prompt_default "AWS profile" "$AWS_PROFILE_NAME")"
  region="$(prompt_default "AWS region" "$AWS_REGION")"
  instance_id="$(prompt_default "Runner EC2 instance id" "$K6_RUNNER_INSTANCE_ID")"
  base_url="$(prompt_default "테스트 대상 API 주소" "$K6_BASE_URL_DEFAULT")"
  run_id="$(prompt_default "결과 이름 Run ID" "${selected}-$(date +%Y%m%d-%H%M%S)")"

  args+=("--profile" "$profile")
  args+=("--region" "$region")
  args+=("--instance-id" "$instance_id")
  args+=("--base-url" "$base_url")
  args+=("--run-id" "$run_id")

  case "$selected" in
    read)
      args+=("--rate" "$(prompt_default "조회 RPS" "5")")
      args+=("--duration" "$(prompt_default "실행 시간" "1m")")
      ;;
    step)
      args+=("--targets" "$(prompt_default "단계별 목표 RPS 목록, 쉼표로 구분" "5,10,20")")
      args+=("--ramp" "$(prompt_default "단계 상승 시간" "30s")")
      args+=("--hold" "$(prompt_default "각 단계 유지 시간" "1m")")
      ;;
    spike)
      args+=("--base-rate" "$(prompt_default "기본 RPS" "2")")
      args+=("--spike-rate" "$(prompt_default "급증 RPS" "15")")
      ;;
    order)
      echo "주의: order 테스트는 실제 주문 데이터를 만들 수 있다." >&2
      confirm_default_yes "주문 테스트를 계속할까요?" || exit 0
      args+=("--store-id" "$(prompt_default "스토어 ID" "1")")
      args+=("--rate" "$(prompt_default "주문 RPS" "2")")
      args+=("--duration" "$(prompt_default "실행 시간" "1m")")
      append_if_set args "--buyer-token" "$(prompt_secret_optional "구매자 access token, 없으면 Enter")"
      ;;
    hot-order)
      echo "주의: hot-order 테스트는 실제 주문 데이터를 만들고 단일 상품 재고를 빠르게 소진할 수 있다." >&2
      confirm_default_yes "핫 상품 주문 쏠림 테스트를 계속할까요?" || exit 0
      args+=("--store-id" "$(prompt_default "스토어 ID" "1")")
      args+=("--rate" "$(prompt_default "핫 상품 주문 RPS" "20")")
      args+=("--duration" "$(prompt_default "실행 시간" "2m")")
      append_if_set args "--env" "K6_HOT_PRODUCT_STOCK=$(prompt_default "테스트 상품 재고" "300")"
      append_if_set args "--env" "K6_HOT_PRODUCT_POOL_SIZE=$(prompt_default "테스트 상품 풀 크기" "1")"
      append_if_set args "--seller-token" "$(prompt_secret_optional "판매자 access token, 없으면 Enter")"
      append_if_set args "--buyer-token" "$(prompt_secret_optional "구매자 access token, 없으면 Enter")"
      ;;
    create)
      echo "주의: create 테스트는 실제 상품 생성/삭제 API를 호출한다." >&2
      confirm_default_yes "상품 생성/삭제 테스트를 계속할까요?" || exit 0
      args+=("--store-id" "$(prompt_default "스토어 ID" "1")")
      args+=("--rate" "$(prompt_default "상품 생성 RPS" "2")")
      args+=("--duration" "$(prompt_default "실행 시간" "1m")")
      append_if_set args "--seller-token" "$(prompt_secret_optional "판매자 access token, 없으면 Enter")"
      ;;
    remaining)
      echo "주의: remaining 테스트는 상품 재고 변경 API를 호출한다." >&2
      confirm_default_yes "재고 변경 테스트를 계속할까요?" || exit 0
      args+=("--store-id" "$(prompt_default "스토어 ID" "1")")
      args+=("--rate" "$(prompt_default "재고 변경 RPS" "2")")
      args+=("--duration" "$(prompt_default "실행 시간" "1m")")
      append_if_set args "--seller-token" "$(prompt_secret_optional "판매자 access token, 없으면 Enter")"
      append_if_set args "--env" "K6_PRODUCT_POOL_SIZE=$(prompt_default "테스트 상품 풀 크기" "10")"
      ;;
    soak)
      echo "주의: soak 테스트는 장시간 실행되며 설정에 따라 주문 데이터를 만들 수 있다." >&2
      confirm_default_yes "장시간 soak 테스트를 계속할까요?" || exit 0
      args+=("--store-id" "$(prompt_default "스토어 ID" "1")")
      args+=("--duration" "$(prompt_default "Soak 실행 시간" "10m")")
      append_if_set args "--env" "K6_SOAK_VUS=$(prompt_default "동시 사용자 VUs" "2")"
      append_if_set args "--env" "K6_SOAK_ORDER_PROBABILITY=$(prompt_default "주문 생성 확률 0-1" "0.2")"
      append_if_set args "--buyer-token" "$(prompt_secret_optional "구매자 access token, 없으면 Enter")"
      ;;
  esac

  wait_answer="$(prompt_default "테스트가 끝날 때까지 기다릴까요? y/n" "y")"
  if [[ "$wait_answer" =~ ^[Yy]$ || "$wait_answer" =~ ^[Yy][Ee][Ss]$ ]]; then
    args+=("--wait")
  fi

  echo
  echo "선택한 테스트: $selected"
  echo "Run ID: $run_id"
  confirm_default_yes "지금 실행할까요?" || exit 0
  echo "테스트 실행 시작: $selected"
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
skip_runner_check=0
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
  hot-order|order-hot-product-race)
    scenario_file="tests/performance/k6/sallijang/order-hot-product-race.js"
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
    die "알 수 없는 테스트 종류: $scenario"
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
        hot-order|order-hot-product-race) env_pairs+=("K6_HOT_ORDER_RATE=${2:?missing value for --rate}") ;;
        create|product-create-load) env_pairs+=("K6_PRODUCT_CREATE_RATE=${2:?missing value for --rate}") ;;
        remaining|product-remaining-load) env_pairs+=("K6_REMAINING_RATE=${2:?missing value for --rate}") ;;
        *) die "이 테스트에서는 --rate 옵션을 지원하지 않습니다: $scenario" ;;
      esac
      shift 2
      ;;
    --duration)
      case "$scenario" in
        read|product-list-load) env_pairs+=("K6_READ_DURATION=${2:?missing value for --duration}") ;;
        order|order-create-load) env_pairs+=("K6_ORDER_DURATION=${2:?missing value for --duration}") ;;
        hot-order|order-hot-product-race) env_pairs+=("K6_HOT_ORDER_DURATION=${2:?missing value for --duration}") ;;
        create|product-create-load) env_pairs+=("K6_PRODUCT_CREATE_DURATION=${2:?missing value for --duration}") ;;
        remaining|product-remaining-load) env_pairs+=("K6_REMAINING_DURATION=${2:?missing value for --duration}") ;;
        soak|buyer-journey-soak) env_pairs+=("K6_SOAK_DURATION=${2:?missing value for --duration}") ;;
        *) die "이 테스트에서는 --duration 옵션을 지원하지 않습니다: $scenario" ;;
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
      [[ "${2:-}" == *=* ]] || die "--env 값은 KEY=VALUE 형식이어야 합니다"
      env_pairs+=("$2")
      shift 2
      ;;
    --wait)
      wait_for_result=1
      shift
      ;;
    --skip-runner-check)
      skip_runner_check=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "알 수 없는 옵션: $1"
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
  [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || die "잘못된 env key: $key"
  remote_command+=" $key=$(shell_quote "$value")"
done

remote_command+=" $(shell_quote "$RUNNER_SCRIPT")"

params_file="$(mktemp)"
trap 'rm -f "$params_file"' EXIT
printf '{"commands":["%s"]}\n' "$(json_escape "$remote_command")" >"$params_file"

echo "테스트 파일: $scenario_file"
echo "Run ID:      $run_id"
echo "Runner EC2:  $K6_RUNNER_INSTANCE_ID"
echo "실행 명령:   AWS SSM용 명령 생성 완료"

if [[ "$skip_runner_check" != "1" ]]; then
  check_runner_ready
fi

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

echo "SSM command id: $command_id"
s3_result_uri="s3://pickup-dev-logs/k6-results/dev/$run_id/"
echo "S3 결과 위치: $s3_result_uri"

if [[ "$wait_for_result" == "1" ]]; then
  echo "테스트 완료까지 기다리는 중..."
  aws ssm wait command-executed \
    --profile "$AWS_PROFILE_NAME" \
    --region "$AWS_REGION" \
    --command-id "$command_id" \
    --instance-id "$K6_RUNNER_INSTANCE_ID"

  invocation_file="$(mktemp)"
  aws ssm get-command-invocation \
    --profile "$AWS_PROFILE_NAME" \
    --region "$AWS_REGION" \
    --command-id "$command_id" \
    --instance-id "$K6_RUNNER_INSTANCE_ID" \
    --output json >"$invocation_file"

  print_pretty_result "$invocation_file" "$run_id" "$command_id" "$s3_result_uri"
fi

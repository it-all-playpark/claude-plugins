#!/usr/bin/env python3
"""
GA4 Data Fetcher - Google Analytics 4 データ取得スクリプト

Usage:
    python ga_fetch.py --property-id PROPERTY_ID [options]

Required:
    --property-id       GA4 Property ID (e.g., 123456789)

Authentication (choose one):
    --oauth-client      Path to OAuth client secrets JSON (default: ~/.config/ga4/client_secret.json)
    --credentials       Path to service account JSON key file (if allowed)

Options:
    --start-date        Start date (YYYY-MM-DD or relative: 30daysAgo, 7daysAgo)
    --end-date          End date (YYYY-MM-DD or today)
    --output            Output file path (default: ga_report.json)
    --report-type       Report type: full, traffic, conversion, content (default: full)
    --token-path        Path to store OAuth tokens (default: ~/.config/ga4/token.json)
"""

import argparse
import json
import os
import sys
from datetime import datetime
from pathlib import Path

# Add _lib to path for config loader
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "_lib"))
from config import merge_config

# Check required packages
try:
    from google.analytics.data_v1beta import BetaAnalyticsDataClient
    from google.analytics.data_v1beta.types import (
        DateRange,
        Dimension,
        Metric,
        RunReportRequest,
    )
except ImportError:
    print("Error: google-analytics-data package not installed")
    print("Run: pip install google-analytics-data")
    sys.exit(1)

# OAuth support
OAUTH_AVAILABLE = True
try:
    from google.oauth2.credentials import Credentials
    from google_auth_oauthlib.flow import InstalledAppFlow
    from google.auth.transport.requests import Request
except ImportError:
    OAUTH_AVAILABLE = False

# Service account support
SA_AVAILABLE = True
try:
    from google.oauth2 import service_account
except ImportError:
    SA_AVAILABLE = False

# Search Console と token を共有するため webmasters も要求する。
# 片方のスコープで再認証すると共有 token からもう片方が落ちる。
SCOPES = [
    "https://www.googleapis.com/auth/analytics.readonly",
    "https://www.googleapis.com/auth/webmasters.readonly",
]
DEFAULT_TOKEN_PATH = Path.home() / ".config" / "ga4" / "token.json"
DEFAULT_OAUTH_CLIENT_PATH = Path.home() / ".config" / "ga4" / "client_secret.json"


def create_oauth_client(
    client_secrets_path: str,
    token_path: Path = DEFAULT_TOKEN_PATH,
) -> BetaAnalyticsDataClient:
    """Create GA4 API client with OAuth 2.0 credentials."""
    if not OAUTH_AVAILABLE:
        print("Error: OAuth packages not installed")
        print("Run: pip install google-auth-oauthlib")
        sys.exit(1)

    creds = None

    # Load existing token if available
    if token_path.exists():
        try:
            creds = Credentials.from_authorized_user_file(str(token_path), SCOPES)
        except Exception as e:
            print(f"Warning: Could not load existing token ({e}), will re-authenticate")
            creds = None

    # Refresh or obtain new credentials
    if creds and creds.expired and creds.refresh_token:
        try:
            creds.refresh(Request())
        except Exception:
            creds = None

    if not creds or not creds.valid:
        if not Path(client_secrets_path).exists():
            print(f"Error: OAuth client secrets file not found: {client_secrets_path}")
            sys.exit(1)

        print("Opening browser for authentication...")
        print("(If browser doesn't open, copy the URL from terminal)")
        flow = InstalledAppFlow.from_client_secrets_file(client_secrets_path, SCOPES)
        creds = flow.run_local_server(port=0)

        # Save token for future use (owner-only permissions)
        token_path.parent.mkdir(parents=True, exist_ok=True)
        token_path.write_text(creds.to_json())
        os.chmod(token_path, 0o600)
        print(f"Token saved to: {token_path}")

    return BetaAnalyticsDataClient(credentials=creds)


def create_service_account_client(credentials_path: str) -> BetaAnalyticsDataClient:
    """Create GA4 API client with service account credentials."""
    if not SA_AVAILABLE:
        print("Error: Service account support not available")
        sys.exit(1)

    credentials = service_account.Credentials.from_service_account_file(
        credentials_path,
        scopes=SCOPES,
    )
    return BetaAnalyticsDataClient(credentials=credentials)


def run_report(
    client: BetaAnalyticsDataClient,
    property_id: str,
    dimensions: list[str],
    metrics: list[str],
    start_date: str,
    end_date: str,
    limit: int = 100,
) -> dict:
    """Run a GA4 report and return results as dict."""
    request = RunReportRequest(
        property=f"properties/{property_id}",
        dimensions=[Dimension(name=d) for d in dimensions],
        metrics=[Metric(name=m) for m in metrics],
        date_ranges=[DateRange(start_date=start_date, end_date=end_date)],
        limit=limit,
    )
    response = client.run_report(request)

    rows = []
    for row in response.rows:
        row_data = {}
        for i, dim in enumerate(dimensions):
            row_data[dim] = row.dimension_values[i].value
        for i, met in enumerate(metrics):
            row_data[met] = row.metric_values[i].value
        rows.append(row_data)

    return {
        "dimensions": dimensions,
        "metrics": metrics,
        "row_count": response.row_count,
        "rows": rows,
    }


def fetch_traffic_report(
    client: BetaAnalyticsDataClient,
    property_id: str,
    start_date: str,
    end_date: str,
) -> dict:
    """Fetch traffic analysis data."""
    reports = {}

    reports["overview"] = run_report(
        client,
        property_id,
        dimensions=["date"],
        metrics=[
            "activeUsers",
            "sessions",
            "screenPageViews",
            "bounceRate",
            "averageSessionDuration",
            "engagementRate",
        ],
        start_date=start_date,
        end_date=end_date,
    )

    reports["traffic_sources"] = run_report(
        client,
        property_id,
        dimensions=["sessionDefaultChannelGroup"],
        metrics=["sessions", "activeUsers", "engagementRate", "conversions"],
        start_date=start_date,
        end_date=end_date,
    )

    reports["source_medium"] = run_report(
        client,
        property_id,
        dimensions=["sessionSourceMedium"],
        metrics=["sessions", "activeUsers", "bounceRate", "averageSessionDuration"],
        start_date=start_date,
        end_date=end_date,
        limit=20,
    )

    reports["devices"] = run_report(
        client,
        property_id,
        dimensions=["deviceCategory"],
        metrics=["sessions", "activeUsers", "bounceRate", "conversions"],
        start_date=start_date,
        end_date=end_date,
    )

    reports["geography"] = run_report(
        client,
        property_id,
        dimensions=["country", "city"],
        metrics=["sessions", "activeUsers"],
        start_date=start_date,
        end_date=end_date,
        limit=20,
    )

    return reports


def fetch_conversion_report(
    client: BetaAnalyticsDataClient,
    property_id: str,
    start_date: str,
    end_date: str,
) -> dict:
    """Fetch conversion analysis data."""
    reports = {}

    reports["conversion_overview"] = run_report(
        client,
        property_id,
        dimensions=["eventName"],
        metrics=["eventCount", "eventCountPerUser", "totalUsers"],
        start_date=start_date,
        end_date=end_date,
        limit=30,
    )

    reports["landing_pages"] = run_report(
        client,
        property_id,
        dimensions=["landingPage"],
        metrics=[
            "sessions",
            "bounceRate",
            "averageSessionDuration",
            "conversions",
            "engagementRate",
        ],
        start_date=start_date,
        end_date=end_date,
        limit=20,
    )

    reports["conversion_by_channel"] = run_report(
        client,
        property_id,
        dimensions=["sessionDefaultChannelGroup"],
        metrics=["conversions", "sessions", "totalUsers"],
        start_date=start_date,
        end_date=end_date,
    )

    return reports


def fetch_content_report(
    client: BetaAnalyticsDataClient,
    property_id: str,
    start_date: str,
    end_date: str,
) -> dict:
    """Fetch content/page analysis data."""
    reports = {}

    reports["page_performance"] = run_report(
        client,
        property_id,
        dimensions=["pagePath"],
        metrics=[
            "screenPageViews",
            "activeUsers",
            "averageSessionDuration",
            "bounceRate",
            "engagementRate",
        ],
        start_date=start_date,
        end_date=end_date,
        limit=30,
    )

    reports["page_titles"] = run_report(
        client,
        property_id,
        dimensions=["pageTitle"],
        metrics=["screenPageViews", "activeUsers", "engagementRate"],
        start_date=start_date,
        end_date=end_date,
        limit=20,
    )

    reports["entry_pages"] = run_report(
        client,
        property_id,
        dimensions=["landingPage"],
        metrics=["sessions", "bounceRate", "engagementRate"],
        start_date=start_date,
        end_date=end_date,
        limit=20,
    )

    reports["exit_analysis"] = run_report(
        client,
        property_id,
        dimensions=["pagePath"],
        metrics=["screenPageViews", "sessions", "bounceRate"],
        start_date=start_date,
        end_date=end_date,
        limit=20,
    )

    return reports


def fetch_full_report(
    client: BetaAnalyticsDataClient,
    property_id: str,
    start_date: str,
    end_date: str,
) -> dict:
    """Fetch comprehensive report combining all analyses."""
    return {
        "traffic": fetch_traffic_report(client, property_id, start_date, end_date),
        "conversion": fetch_conversion_report(client, property_id, start_date, end_date),
        "content": fetch_content_report(client, property_id, start_date, end_date),
        "metadata": {
            "property_id": property_id,
            "start_date": start_date,
            "end_date": end_date,
            "generated_at": datetime.now().isoformat(),
        },
    }


def main():
    # Load project config
    config = merge_config({"property_id": None}, "ga-analyzer")

    parser = argparse.ArgumentParser(description="Fetch GA4 analytics data")
    parser.add_argument("--property-id", required=False, default=None, help="GA4 Property ID")

    # Authentication options (mutually exclusive; oauth-client defaults if neither specified)
    auth_group = parser.add_mutually_exclusive_group()
    auth_group.add_argument(
        "--oauth-client",
        default=None,
        help="Path to OAuth client secrets JSON (default: ~/.config/ga4/client_secret.json)",
    )
    auth_group.add_argument(
        "--credentials",
        help="Path to service account JSON (if allowed in your org)",
    )

    parser.add_argument("--start-date", default="30daysAgo", help="Start date")
    parser.add_argument("--end-date", default="today", help="End date")
    parser.add_argument("--output", default="ga_report.json", help="Output file path")
    parser.add_argument(
        "--report-type",
        choices=["full", "traffic", "conversion", "content"],
        default="full",
        help="Type of report to generate",
    )
    parser.add_argument(
        "--token-path",
        type=Path,
        default=DEFAULT_TOKEN_PATH,
        help="Path to store OAuth tokens",
    )

    args = parser.parse_args()

    # Resolve property_id: CLI arg > config
    property_id = args.property_id or config.get("property_id")
    if not property_id:
        print("Error: --property-id is required (or set in skill-config.json)", file=sys.stderr)
        sys.exit(1)
    args.property_id = property_id

    # Apply default oauth-client path when neither auth option is specified
    if args.oauth_client is None and args.credentials is None:
        args.oauth_client = str(DEFAULT_OAUTH_CLIENT_PATH)

    # Create client based on auth method
    if args.credentials:
        print("Using service account authentication...")
        if not Path(args.credentials).exists():
            print(f"Error: Credentials file not found: {args.credentials}")
            sys.exit(1)
        client = create_service_account_client(args.credentials)
    else:
        print("Using OAuth 2.0 authentication...")
        client = create_oauth_client(args.oauth_client, args.token_path)

    print(f"Connecting to GA4 property: {args.property_id}")
    print(f"Fetching {args.report_type} report...")
    print(f"Date range: {args.start_date} to {args.end_date}")

    fetch_funcs = {
        "full": fetch_full_report,
        "traffic": fetch_traffic_report,
        "conversion": fetch_conversion_report,
        "content": fetch_content_report,
    }

    report = fetch_funcs[args.report_type](
        client, args.property_id, args.start_date, args.end_date
    )

    if args.report_type != "full":
        report = {
            args.report_type: report,
            "metadata": {
                "property_id": args.property_id,
                "start_date": args.start_date,
                "end_date": args.end_date,
                "generated_at": datetime.now().isoformat(),
                "report_type": args.report_type,
            },
        }

    output_path = Path(args.output)
    output_path.write_text(json.dumps(report, indent=2, ensure_ascii=False))
    print(f"Report saved to: {output_path}")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Set the agreed iOS environment contract from files/stdin, without logging values.

Run only after the Apple owner confirms app/profile/signing readiness.
The environment must already exist with a main-only deployment policy.
"""
import base64
import os
from pathlib import Path
import subprocess
import sys

REPO = 'zorid-app/Zorid'
ENVIRONMENT = 'ios-testflight'


def required(name):
    value = os.environ.get(name, '')
    if not value:
        raise ValueError(f'Missing {name}')
    return value


def encoded(name):
    data = Path(required(name)).expanduser().read_bytes()
    if not data:
        raise ValueError(f'Empty file for {name}')
    return base64.b64encode(data)


def main():
    # Read everything before the first remote write. Never source/eval metadata.
    metadata_path = Path(os.environ.get('ASC_METADATA_PATH', '~/certificates/apple/team/app-store-connect-api/metadata.txt')).expanduser()
    metadata = {}
    for line in metadata_path.read_text().splitlines():
        key, separator, value = line.strip().partition('=')
        if separator and key in ('APP_STORE_CONNECT_KEY_ID', 'APP_STORE_CONNECT_ISSUER_ID'):
            metadata[key] = value.strip().strip('\"\'')
    key_id = metadata['APP_STORE_CONNECT_KEY_ID']
    issuer = metadata['APP_STORE_CONNECT_ISSUER_ID']
    import re
    if not re.fullmatch(r'[A-Za-z0-9]+', key_id) or not re.fullmatch(r'[A-Fa-f0-9-]{36}', issuer):
        raise ValueError('Invalid API metadata format')
    key_path = metadata_path.parent / f'AuthKey_{key_id}.p8'
    password = Path(required('IOS_DISTRIBUTION_P12_PASSWORD_PATH')).expanduser().read_bytes()
    # Password file is exact bytes, with no implicit newline trimming.
    secrets = {
        'IOS_DISTRIBUTION_P12_BASE64': encoded('IOS_DISTRIBUTION_P12_PATH'),
        'IOS_DISTRIBUTION_P12_PASSWORD': password,
        'IOS_PROVISION_PROFILE_BASE64': encoded('IOS_PROVISION_PROFILE_PATH'),
        'IOS_TEAM_ID': required('IOS_TEAM_ID').encode(),
        'ASC_API_KEY_ID': key_id.encode(),
        'ASC_API_ISSUER_ID': issuer.encode(),
        'ASC_API_PRIVATE_KEY_BASE64': base64.b64encode(key_path.read_bytes()),
    }
    for name, value in secrets.items():
        result = subprocess.run(['gh', 'secret', 'set', name, '--repo', REPO, '--env', ENVIRONMENT],
                                input=value, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if result.returncode:
            print(f'Failed setting {name}; earlier writes may have succeeded. Check gh auth/environment permissions and retry the complete contract.', file=sys.stderr)
            return 1
    print('Set all seven ios-testflight secrets; values were not displayed.')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:
        print('Secret setup failed; check required local file paths, API metadata, and gh availability. No credential details are logged.', file=sys.stderr)
        sys.exit(1)

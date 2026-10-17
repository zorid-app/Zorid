#!/usr/bin/env python3
"""Prepare disposable signing files; never print credential content."""
import base64
import datetime
import hashlib
import re
import os
import pathlib
import plistlib
import shutil
import subprocess
import sys


class InputError(Exception):
    """Safe, fixed diagnostic text; never includes credential content."""


def run(*args):
    return subprocess.run(args, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout


def materialize(directory, name, file_var, secret_var):
    destination = directory / name
    source = os.environ.get(file_var)
    if source:
        destination.write_bytes(pathlib.Path(source).expanduser().read_bytes())
    else:
        value = os.environ.get(secret_var, '')
        if not value:
            raise InputError(f'Set {file_var} or {secret_var}')
        destination.write_bytes(base64.b64decode(value, validate=True))
    destination.chmod(0o600)
    return destination


def prepare(directory):
    p12 = materialize(directory, 'distribution.p12', 'IOS_DISTRIBUTION_P12_PATH', 'IOS_DISTRIBUTION_P12_BASE64')
    profile = materialize(directory, 'profile.mobileprovision', 'IOS_PROVISION_PROFILE_PATH', 'IOS_PROVISION_PROFILE_BASE64')
    decoded = plistlib.loads(run('security', 'cms', '-D', '-i', str(profile)))
    team = os.environ['IOS_TEAM_ID']
    entitlements = decoded['Entitlements']
    if team not in decoded.get('TeamIdentifier', []):
        raise InputError('Provisioning profile team mismatch')
    if entitlements.get('application-identifier') != f'{team}.app.zorid.notes':
        raise InputError('Provisioning profile must match app.zorid.notes exactly')
    if entitlements.get('get-task-allow') or decoded.get('ProvisionedDevices') or decoded.get('ProvisionsAllDevices'):
        raise InputError('An App Store distribution profile is required')
    if decoded['ExpirationDate'] <= datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None):
        raise InputError('Provisioning profile expired')
    uuid = decoded['UUID']
    if not re.fullmatch(r'[A-Fa-f0-9-]{36}', uuid):
        raise InputError('Invalid profile UUID')
    (directory / 'profile-uuid').write_text(uuid)
    # Preserve the exact user search list and restore it in cleanup.
    import shlex
    search = shlex.split(run('security', 'list-keychains', '-d', 'user').decode())
    (directory / 'search-list.plist').write_bytes(plistlib.dumps(search))
    keychain = str(directory / 'signing.keychain-db')
    password = os.urandom(32).hex()
    run('security', 'create-keychain', '-p', password, keychain)
    run('security', 'set-keychain-settings', '-lut', '21600', keychain)
    run('security', 'unlock-keychain', '-p', password, keychain)
    run('security', 'import', str(p12), '-P', os.environ.get('IOS_DISTRIBUTION_P12_PASSWORD', ''), '-A', '-t', 'cert', '-f', 'pkcs12', '-k', keychain)
    run('security', 'set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-k', password, keychain)
    run('security', 'list-keychains', '-d', 'user', '-s', keychain, *search)
    identities = run('security', 'find-identity', '-v', '-p', 'codesigning', keychain)
    allowed = {hashlib.sha1(cert).hexdigest().upper() for cert in decoded['DeveloperCertificates']}
    matched = [fingerprint for fingerprint, label in re.findall(r'([A-F0-9]{40}) \"([^\"]+)\"', identities.decode())
               if fingerprint in allowed and label.startswith('Apple Distribution:')]
    if len(matched) != 1:
        raise InputError('P12 must contain exactly one valid Apple Distribution identity authorized by the profile')
    identity = matched[0]
    (directory / 'signing-identity').write_text(identity)
    # Support old and current Xcode profile locations, preserving preexisting profiles.
    for folder in ['Library/MobileDevice/Provisioning Profiles', 'Library/Developer/Xcode/UserData/Provisioning Profiles']:
        destination = pathlib.Path.home() / folder / f'{uuid}.mobileprovision'
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.exists():
            if destination.read_bytes() != profile.read_bytes():
                raise InputError('A different local profile with the same UUID already exists')
        else:
            # Journal before write so interrupted copies are cleaned too.
            with (directory / 'installed-profiles').open('a') as journal:
                journal.write(str(destination) + '\n')
            shutil.copyfile(profile, destination)
            destination.chmod(0o600)
    options = {'method': 'app-store-connect', 'destination': 'export', 'signingStyle': 'manual',
               'teamID': team, 'signingCertificate': identity,
               'provisioningProfiles': {'app.zorid.notes': uuid},
               'manageAppVersionAndBuildNumber': False, 'uploadSymbols': True}
    (directory / 'ExportOptions.plist').write_bytes(plistlib.dumps(options))


def upload_key(directory):
    key_id = os.environ['ASC_API_KEY_ID']
    if not re.fullmatch(r'[A-Za-z0-9]+', key_id):
        raise InputError('Invalid ASC_API_KEY_ID')
    keys = directory / 'private_keys'
    keys.mkdir(mode=0o700, exist_ok=True)
    materialize(keys, f'AuthKey_{key_id}.p8', 'ASC_API_PRIVATE_KEY_PATH', 'ASC_API_PRIVATE_KEY_BASE64')


def cleanup(directory):
    failed = False
    journal = directory / 'installed-profiles'
    if journal.exists():
        for name in journal.read_text().splitlines():
            try:
                pathlib.Path(name).unlink(missing_ok=True)
            except OSError:
                failed = True
    search_file = directory / 'search-list.plist'
    if search_file.exists():
        try:
            run('security', 'list-keychains', '-d', 'user', '-s', *plistlib.loads(search_file.read_bytes()))
        except subprocess.CalledProcessError:
            failed = True
    keychain = directory / 'signing.keychain-db'
    if keychain.exists():
        try:
            run('security', 'delete-keychain', str(keychain))
        except subprocess.CalledProcessError:
            failed = True
    if failed:
        raise InputError('Signing cleanup failed; remove the temporary keychain/profile manually')
    shutil.rmtree(directory)


if __name__ == '__main__':
    try:
        operation, location = sys.argv[1:]
        {'prepare': prepare, 'upload-key': upload_key, 'cleanup': cleanup}[operation](pathlib.Path(location))
    except InputError as error:
        print(f'iOS signing: {error}', file=sys.stderr)
        sys.exit(1)
    except (Exception, KeyboardInterrupt):
        # Subprocess errors may contain sensitive arguments/output: intentionally do not echo.
        print('iOS signing operation failed; check input files, team/profile validity, and local keychain access.', file=sys.stderr)
        sys.exit(1)

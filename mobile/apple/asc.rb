#!/usr/bin/env ruby
# Official App Store Connect API helper. Never log auth headers or raw responses.
require 'json'
require 'net/http'
require 'openssl'
require 'jwt'
require 'uri'

class ASC
  BASE = 'https://api.appstoreconnect.apple.com'
  BUNDLE = 'app.zorid.notes'
  TESTER = 'tingkaichiu.ca@gmail.com'

  def initialize
    directory = File.expand_path(ENV.fetch('ZORID_APPLE_API_DIRECTORY', '~/certificates/apple/team/app-store-connect-api'))
    metadata = File.readlines(File.join(directory, 'metadata.txt'), chomp: true).filter_map do |line|
      key, value = line.split('=', 2)
      [key.strip, value.strip] if value
    end.to_h
    key_id = metadata.fetch('APP_STORE_CONNECT_KEY_ID')
    issuer = metadata.fetch('APP_STORE_CONNECT_ISSUER_ID')
    key = OpenSSL::PKey.read(File.read(File.join(directory, "AuthKey_#{key_id}.p8")))
    now = Time.now.to_i
    @token = JWT.encode({iss: issuer, iat: now - 5, exp: now + 600, aud: 'appstoreconnect-v1'}, key, 'ES256', {kid: key_id, typ: 'JWT'})
  end

  def request(method, path, body = nil)
    uri = URI(BASE + path)
    klass = {get: Net::HTTP::Get, post: Net::HTTP::Post}.fetch(method)
    request = klass.new(uri)
    request['Authorization'] = "Bearer #{@token}"
    request['Content-Type'] = 'application/json'
    request.body = JSON.generate(body) if body
    response = Net::HTTP.start(uri.hostname, uri.port, use_ssl: true, open_timeout: 15, read_timeout: 45) { |http| http.request(request) }
    begin
      result = response.body.to_s.empty? ? {} : JSON.parse(response.body)
    rescue JSON::ParserError
      raise "ASC #{method.to_s.upcase} #{uri.path}: HTTP #{response.code} (INVALID_JSON_RESPONSE)"
    end
    unless response.is_a?(Net::HTTPSuccess)
      # Codes are useful to diagnose scope failures; response details may contain account data.
      codes = result.fetch('errors', []).map { |error| error['code'] }.compact.join(',')
      raise "ASC #{method.to_s.upcase} #{uri.path}: HTTP #{response.code} (#{codes})"
    end
    result
  end

  def list(path, params = {})
    url = path + (params.empty? ? '' : '?' + URI.encode_www_form(params))
    values = []
    loop do
      result = request(:get, url)
      values.concat(result.fetch('data'))
      next_url = result.dig('links', 'next')
      break unless next_url
      uri = URI(next_url)
      raise 'Unexpected pagination host' unless uri.scheme == 'https' && uri.host == URI(BASE).host
      url = uri.request_uri
    end
    values
  end

  def apps
    list('/v1/apps', {'filter[bundleId]' => BUNDLE})
  end

  def bundle
    list('/v1/bundleIds', {'filter[identifier]' => BUNDLE})
  end

  def probe(path, params = {})
    list(path, params)
  rescue StandardError => error
    return {error: error.message} if error.message.start_with?('ASC ')
    raise
  end

  def diagnostics
    checks = {
      apps: ['/v1/apps', {'filter[bundleId]' => BUNDLE}],
      bundle_ids: ['/v1/bundleIds', {'filter[identifier]' => BUNDLE}],
      requested_team_user: ['/v1/users', {'filter[username]' => TESTER}],
      requested_invitation: ['/v1/userInvitations', {'filter[email]' => TESTER}]
    }
    failed = false
    checks.each do |label, arguments|
      result = probe(*arguments)
      failed ||= result.is_a?(Hash)
      safe = result.is_a?(Hash) ? result : result.map do |item|
        attributes = item.fetch('attributes', {})
        {id: item['id'], attributes: attributes.select { |key, _| %w[name identifier platform roles allAppsVisible provisioningAllowed].include?(key) }}
      end
      puts JSON.generate(check: label, result: safe)
    end
    !failed
  end

  def status
    found_apps = apps
    found_bundles = bundle
    users = list('/v1/users', {'filter[username]' => TESTER})
    invitations = list('/v1/userInvitations', {'filter[email]' => TESTER})
    summary = {
      bundle_id: BUNDLE,
      apps: found_apps.map { |item| {id: item['id'], name: item.dig('attributes', 'name')} },
      bundle_registrations: found_bundles.map { |item| {id: item['id'], name: item.dig('attributes', 'name'), platform: item.dig('attributes', 'platform')} },
      requested_tester: TESTER,
      team_users: users.map { |item| {id: item['id'], roles: item.dig('attributes', 'roles'), all_apps_visible: item.dig('attributes', 'allAppsVisible')} },
      pending_invitations: invitations.map { |item| {id: item['id'], roles: item.dig('attributes', 'roles'), all_apps_visible: item.dig('attributes', 'allAppsVisible')} }
    }
    unless found_apps.empty?
      id = found_apps.fetch(0).fetch('id')
      summary[:groups] = list("/v1/apps/#{id}/betaGroups").map { |item| {id: item['id'], name: item.dig('attributes', 'name'), internal: item.dig('attributes', 'isInternalGroup')} }
      summary[:build_count] = list("/v1/apps/#{id}/builds").length
    end
    puts JSON.pretty_generate(summary)
  end

  def register_bundle
    existing = bundle
    if existing.empty?
      created = request(:post, '/v1/bundleIds', {data: {type: 'bundleIds', attributes: {identifier: BUNDLE, name: 'Zorid', platform: 'IOS'}}})
      puts JSON.generate(action: 'bundle_registered', id: created.dig('data', 'id'), identifier: BUNDLE)
    else
      puts JSON.generate(action: 'bundle_already_registered', id: existing.first['id'], identifier: BUNDLE)
    end
  end
end

begin
  client = ASC.new
  case ARGV
  when ['diagnostics'] then exit(client.diagnostics ? 0 : 1)
  when ['status'] then client.status
  when ['register-bundle'] then client.register_bundle
  else abort 'Usage: asc.rb diagnostics | status | register-bundle'
  end
rescue StandardError => error
  # Do not print exceptions from crypto/HTTP libraries that could contain credentials.
  warn(error.message.start_with?('ASC ', 'Unexpected pagination') ? error.message : "Apple helper failed (#{error.class}); inspect credentials locally without logging their contents.")
  exit 1
end

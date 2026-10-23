local function renew(key, now)
  local period = tonumber(redis.call('HGET', key, 'period') or '0')
  local expiry = tonumber(redis.call('HGET', key, 'exp') or '0')
  if period > 0 and expiry > 0 and expiry <= now then
    expiry = expiry + (math.floor((now - expiry) / period) + 1) * period
    redis.call('HSET', key, 'exp', expiry, 'used', 0)
    redis.call('PEXPIREAT', key, expiry + 2592000000)
  end
end

-- Only an existing identity may be extended. Missing identities revoke forwarding.
local function identity_alive(key, now, refresh)
  local identity = redis.call('HGET', key, 'identity')
  if not identity then return true end -- legacy synthetic cookie sessions
  if redis.call('EXISTS', identity) == 0 then
    redis.call('HSET', key, 'stopped', 1)
    redis.call('HINCRBY', key, 'rev', 1)
    return false
  end
  if refresh then redis.call('PEXPIREAT', identity, now + 2592000000) end
  return true
end

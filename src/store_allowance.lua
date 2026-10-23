local function renew(key, now)
  local period = tonumber(redis.call('HGET', key, 'period') or '0')
  local expiry = tonumber(redis.call('HGET', key, 'exp') or '0')
  if period > 0 and expiry > 0 and expiry <= now then
    expiry = expiry + (math.floor((now - expiry) / period) + 1) * period
    redis.call('HSET', key, 'exp', expiry, 'used', 0)
    redis.call('PEXPIREAT', key, expiry + 2592000000)
  end
end

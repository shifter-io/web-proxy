if redis.call('EXISTS', KEYS[1]) == 1 or redis.call('EXISTS', KEYS[2]) == 0 then return 0 end
local expiry = tonumber(ARGV[1]) + tonumber(ARGV[2])
for _, field in ipairs({'country', 'sid', 'region', 'used', 'stopped', 'rev'}) do
  redis.call('HSET', KEYS[1], field, redis.call('HGET', KEYS[2], field))
end
redis.call('HSET', KEYS[1], 'exp', expiry, 'period', ARGV[2], 'limit', ARGV[3])
redis.call('PEXPIREAT', KEYS[1], expiry + 2592000000)
redis.call('HSET', KEYS[2], 'stopped', 1)
redis.call('HINCRBY', KEYS[2], 'rev', 1)
return 1

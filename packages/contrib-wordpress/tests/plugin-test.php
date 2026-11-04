<?php
// Isolated hook/proxy contract test, not a running WordPress installation.
define('ABSPATH', __DIR__);
class WP_Error { public function __construct(public string $code, public string $message, public array $data) {} }
class Result { public array $headers = array(); public function __construct(public array $data) {} public function header($name, $value) { $this->headers[$name] = $value; } }
class Request { public function __construct(private mixed $data) {} public function get_json_params() { return $this->data; } }
$hooks = array(); $shortcodes = array(); $calls = array(); $counters = array(); $counterBroken = false; $config = array('api_url' => 'https://docslurp.test', 'workspace_id' => 'public-workspace', 'api_key' => 'server-key-fixture');
function add_action($name, $callback) { global $hooks; $hooks[$name] = $callback; }
function add_shortcode($name, $callback) { global $shortcodes; $shortcodes[$name] = $callback; }
function add_filter(...$args) {}
function register_rest_route($namespace, $path, $options) { global $handler; $handler = $options['callback']; }
function get_option(...$args) { global $config; return $config; }
// An object cache whose incr is atomic, as memcached and Redis are; the database path is not exercised here.
function wp_using_ext_object_cache() { return true; }
function wp_cache_add($key, $value, $group, $ttl) { global $counters; $counters[$key] ??= $value; return true; }
function wp_cache_incr($key, $by, $group) { global $counters, $counterBroken; if ($counterBroken) { return false; } return $counters[$key] = ($counters[$key] ?? 0) + $by; }
function wp_safe_remote_post($url, $options) { global $calls; $calls[] = array($url, $options); return array('code' => 200, 'body' => json_encode(array('results' => array(array('text' => '<unsafe> source', 'citation' => array('filename' => 'Public guide', 'pageNumbers' => array(1), 'documentId' => 'private-id')),), 'usage' => array('internal' => 'private')))); }
function is_wp_error($value) { return $value instanceof WP_Error; }
function wp_remote_retrieve_response_code($value) { return $value['code']; }
function wp_remote_retrieve_body($value) { return $value['body']; }
function wp_json_encode($value) { return json_encode($value); }
function rest_ensure_response($value) { return new Result($value); }
function wp_enqueue_script(...$args) {}
function plugins_url($path, $file) { return '/plugins/' . $path; }
function rest_url($path) { return '/wp-json/' . $path; }
function esc_url($value) { return htmlspecialchars($value, ENT_QUOTES); }
function check($condition, $message) { if (!$condition) { throw new Exception($message); } }
require dirname(__DIR__) . '/docslurp-search/docslurp-search.php';
$hooks['rest_api_init']();
check(!str_contains($shortcodes['docslurp_search'](), 'server-key-fixture'), 'Server key leaked into shortcode HTML');
foreach (array(array('q' => 'query', 'workspace' => 'other'), array('q' => 5), array('q' => str_repeat('x', 501))) as $invalid) {
    $result = $handler(new Request($invalid)); check($result instanceof WP_Error && $result->data['status'] === 400, 'Invalid input accepted');
}
check(count($calls) === 0, 'Invalid input incurred API requests');
$result = $handler(new Request(array('q' => 'installation')));
check($result->data['results'][0]['text'] === '<unsafe> source', 'Source text changed');
check(!isset($result->data['usage']), 'Internal metadata exposed');
check(!isset($result->data['results'][0]['citation']['documentId']), 'Internal document ID exposed');
check($result->headers['Cache-Control'] === 'no-store', 'Proxy response cached');
$request = $calls[0][1]; $body = json_decode($request['body'], true);
check($body['workspace'] === 'public-workspace' && $body['limit'] === 6, 'Caller controlled search scope');
check($request['redirection'] === 0 && $request['headers']['Authorization'] === 'Bearer server-key-fixture', 'Invalid credential transport');
check($body['hyde'] === false && $body['compression'] === false, 'Expansion enabled unexpectedly');
$handler(new Request(array('q' => ''))); check(count($calls) === 1, 'Empty search incurred usage');

// Rate limits: 30 searches per visitor per minute, counted atomically, keyed on the visitor's address.
$counters = array(); $calls = array();
$search = function (string $query = 'again') use (&$handler) { return $handler(new Request(array('q' => $query))); };
$_SERVER['REMOTE_ADDR'] = '203.0.113.7';
for ($i = 1; $i <= 30; $i++) { $answer = $search(); check($answer instanceof Result, "Search $i of 30 was refused"); }
$answer = $search(); check($answer instanceof WP_Error && $answer->data['status'] === 429, 'The 31st search from one address was not limited');
$_SERVER['REMOTE_ADDR'] = '203.0.113.8';
check($search() instanceof Result, 'Another visitor shared the first visitor limit');
// An untrusted peer cannot choose its bucket by sending X-Forwarded-For.
$_SERVER['REMOTE_ADDR'] = '203.0.113.7'; $_SERVER['HTTP_X_FORWARDED_FOR'] = '198.51.100.99';
$answer = $search(); check($answer instanceof WP_Error && $answer->data['status'] === 429, 'A spoofed X-Forwarded-For escaped the limit');
// Behind a listed proxy the client is the first address that is not a listed proxy, read from the right.
$config['trusted_proxies'] = '10.0.0.0/8, 192.0.2.1';
$_SERVER['REMOTE_ADDR'] = '10.1.2.3'; $_SERVER['HTTP_X_FORWARDED_FOR'] = '198.51.100.50, 10.9.9.9';
check(docslurp_search_client_ip($_SERVER, array('10.0.0.0/8')) === '198.51.100.50', 'Trusted proxy chain not unwound');
$_SERVER['HTTP_X_FORWARDED_FOR'] = '6.6.6.6, 198.51.100.50, 10.9.9.9';
check(docslurp_search_client_ip($_SERVER, array('10.0.0.0/8')) === '198.51.100.50', 'A client-supplied left hop was believed');
check(docslurp_search_client_ip(array('REMOTE_ADDR' => '172.16.0.1', 'HTTP_X_FORWARDED_FOR' => '1.2.3.4'), array('10.0.0.0/8')) === '172.16.0.1', 'An unlisted peer header was believed');
check(docslurp_search_ip_matches('2001:db8::1', '2001:db8::/32') && !docslurp_search_ip_matches('2001:db9::1', '2001:db8::/32'), 'IPv6 range matching failed');
check(docslurp_search_ip_matches('10.200.1.1', '10.128.0.0/9') && !docslurp_search_ip_matches('10.100.1.1', '10.128.0.0/9'), 'Non byte-aligned range matching failed');
$first = null; $counters = array();
for ($i = 1; $i <= 30; $i++) { $_SERVER['HTTP_X_FORWARDED_FOR'] = '198.51.100.50'; $search(); }
$_SERVER['HTTP_X_FORWARDED_FOR'] = '198.51.100.51'; check($search() instanceof Result, 'Two visitors behind one proxy shared a bucket');
$_SERVER['HTTP_X_FORWARDED_FOR'] = '198.51.100.50'; $answer = $search(); check($answer instanceof WP_Error && $answer->data['status'] === 429, 'A visitor behind a proxy escaped their limit');
// A hit that cannot be counted is refused, not allowed.
$config['trusted_proxies'] = ''; $counterBroken = true; $before = count($calls);
$answer = $search(); check($answer instanceof WP_Error && $answer->data['status'] === 503 && count($calls) === $before, 'An uncountable request was waved through');
echo "WordPress shortcode/proxy contract checks passed\n";

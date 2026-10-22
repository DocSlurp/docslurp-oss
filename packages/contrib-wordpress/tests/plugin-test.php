<?php
// Isolated hook/proxy contract test, not a running WordPress installation.
define('ABSPATH', __DIR__);
class WP_Error { public function __construct(public string $code, public string $message, public array $data) {} }
class Result { public array $headers = array(); public function __construct(public array $data) {} public function header($name, $value) { $this->headers[$name] = $value; } }
class Request { public function __construct(private mixed $data) {} public function get_json_params() { return $this->data; } }
$hooks = array(); $shortcodes = array(); $calls = array(); $transients = array();
function add_action($name, $callback) { global $hooks; $hooks[$name] = $callback; }
function add_shortcode($name, $callback) { global $shortcodes; $shortcodes[$name] = $callback; }
function add_filter(...$args) {}
function register_rest_route($namespace, $path, $options) { global $handler; $handler = $options['callback']; }
function get_option(...$args) { return array('api_url' => 'https://docslurp.test', 'workspace_id' => 'public-workspace', 'api_key' => 'server-key-fixture'); }
function get_transient($name) { global $transients; return $transients[$name] ?? 0; }
function set_transient($name, $value, $ttl) { global $transients; $transients[$name] = $value; }
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
echo "WordPress shortcode/proxy contract checks passed\n";

<?php
/**
 * Plugin Name: DocSlurp Search
 * Description: Cited document search via [docslurp_search], with a private server search proxy.
 * Version: 0.1.0
 * License: MIT
 * License URI: https://opensource.org/license/mit/
 */
if (!defined('ABSPATH')) { exit; }

add_action('admin_menu', function () {
    add_options_page('DocSlurp Search', 'DocSlurp Search', 'manage_options', 'docslurp-search', 'docslurp_search_settings');
});
add_action('admin_init', function () {
    register_setting('docslurp_search', 'docslurp_search_config', array('sanitize_callback' => function ($value) {
        $url = esc_url_raw($value['api_url'] ?? 'https://docslurp.io', array('https'));
        if (wp_parse_url($url, PHP_URL_SCHEME) !== 'https') { $url = ''; }
        $key = sanitize_text_field($value['api_key'] ?? '');
        // The proxy calls DocSlurp server-to-server, so a browser key (dslp_pub_) can never authenticate here.
        if (strpos($key, 'dslp_pub_') === 0) {
            add_settings_error('docslurp_search_config', 'browser_key', 'Use a search-only server key (dslp_priv_…). Browser keys (dslp_pub_…) only work from the listed websites. The previous key was kept.');
            $previous = get_option('docslurp_search_config', array());
            $key = is_array($previous) ? ($previous['api_key'] ?? '') : '';
        }
        // Only addresses and CIDR ranges of reverse proxies in front of this site; anything else is dropped.
        $proxies = array();
        foreach (preg_split('/[\s,]+/', (string) ($value['trusted_proxies'] ?? ''), -1, PREG_SPLIT_NO_EMPTY) as $entry) {
            $parts = explode('/', $entry, 2);
            if (filter_var($parts[0], FILTER_VALIDATE_IP) && (!isset($parts[1]) || ctype_digit($parts[1]))) { $proxies[] = $entry; }
        }
        return array('api_url' => untrailingslashit($url), 'workspace_id' => sanitize_text_field($value['workspace_id'] ?? ''), 'api_key' => $key, 'trusted_proxies' => implode(', ', $proxies));
    }));
});
function docslurp_search_settings() {
    if (!current_user_can('manage_options')) { return; }
    $config = get_option('docslurp_search_config', array());
    echo '<div class="wrap"><h1>DocSlurp Search</h1><p>Use a search-only server key for a workspace whose passages may be public. The shortcode makes search public, without exposing the key. Ingestion stays in DocSlurp.</p><form action="options.php" method="post">';
    settings_fields('docslurp_search');
    foreach (array('api_url' => 'API origin (HTTPS)', 'workspace_id' => 'Workspace ID, slug or name (optional; blank uses the default workspace)', 'api_key' => 'Search-only server API key', 'trusted_proxies' => 'Trusted reverse proxies (optional; IPs or CIDR ranges, comma separated). Visitor rate limits use the address a trusted proxy reports in X-Forwarded-For; leave blank when WordPress is reached directly.') as $name => $label) {
        echo '<p><label>' . esc_html($label) . '<br><input class="regular-text" name="docslurp_search_config[' . esc_attr($name) . ']" type="' . ($name === 'api_key' ? 'password' : 'text') . '" value="' . esc_attr($config[$name] ?? ($name === 'api_url' ? 'https://docslurp.io' : '')) . '" autocomplete="off"></label></p>';
    }
    submit_button(); echo '</form><p>Add <code>[docslurp_search]</code> to a page or post.</p></div>';
}
/** Whether `$ip` is `$entry` (an address) or inside it (a CIDR range). IPv4 and IPv6. */
function docslurp_search_ip_matches($ip, $entry) {
    $parts = explode('/', trim($entry), 2);
    $address = @inet_pton($ip); $network = @inet_pton($parts[0]);
    if ($address === false || $network === false || strlen($address) !== strlen($network)) { return false; }
    $bits = isset($parts[1]) && ctype_digit($parts[1]) ? (int) $parts[1] : strlen($address) * 8;
    if ($bits > strlen($address) * 8) { return false; }
    $whole = intdiv($bits, 8); $rest = $bits % 8;
    if ($whole > 0 && substr($address, 0, $whole) !== substr($network, 0, $whole)) { return false; }
    if ($rest > 0) {
        $mask = (0xFF << (8 - $rest)) & 0xFF;
        if ((ord($address[$whole]) & $mask) !== (ord($network[$whole]) & $mask)) { return false; }
    }
    return true;
}
function docslurp_search_ip_listed($ip, $entries) {
    foreach ($entries as $entry) { if (docslurp_search_ip_matches($ip, $entry)) { return true; } }
    return false;
}
/**
 * The visitor's address for rate limiting. REMOTE_ADDR is the connection peer: behind a reverse proxy or CDN it is the
 * proxy, so every visitor would share one bucket. Only when the peer is a proxy the site owner listed is X-Forwarded-For
 * read, from the right, skipping listed proxies; the first address not in the list is the client. A header sent by an
 * untrusted peer is never believed, so a visitor cannot pick their own bucket.
 */
function docslurp_search_client_ip($server, $trusted_proxies) {
    $peer = (string) ($server['REMOTE_ADDR'] ?? '');
    if ($peer === '' || !$trusted_proxies || !docslurp_search_ip_listed($peer, $trusted_proxies)) { return $peer; }
    $hops = array_reverse(array_map('trim', explode(',', (string) ($server['HTTP_X_FORWARDED_FOR'] ?? ''))));
    foreach ($hops as $hop) {
        if (filter_var($hop, FILTER_VALIDATE_IP) && !docslurp_search_ip_listed($hop, $trusted_proxies)) { return $hop; }
    }
    return $peer;
}
/**
 * Counts one hit in a one-minute window and returns the count including it, or null when it cannot be counted.
 * The increment is atomic (an object cache's incr, or a single UPDATE ... LAST_INSERT_ID(value + 1) on the options
 * table), so concurrent requests cannot both read the same count and slip past the limit.
 */
function docslurp_search_count_hit($name) {
    if (wp_using_ext_object_cache()) {
        wp_cache_add($name, 0, 'docslurp_search', 120);
        $count = wp_cache_incr($name, 1, 'docslurp_search');
        return $count === false ? null : (int) $count;
    }
    global $wpdb;
    $option = 'dslp_rl_' . $name;
    $wpdb->query($wpdb->prepare("INSERT IGNORE INTO {$wpdb->options} (option_name, option_value, autoload) VALUES (%s, '0', 'no')", $option));
    $updated = $wpdb->query($wpdb->prepare("UPDATE {$wpdb->options} SET option_value = LAST_INSERT_ID(option_value + 1) WHERE option_name = %s", $option));
    if ($updated === false || $updated === 0) { return null; }
    $count = $wpdb->get_var('SELECT LAST_INSERT_ID()');
    // Old windows are dropped now and then (names are dslp_rl_<minute>_<scope>).
    if (mt_rand(1, 50) === 1) {
        $wpdb->query($wpdb->prepare("DELETE FROM {$wpdb->options} WHERE option_name LIKE 'dslp\\_rl\\_%%' AND CAST(SUBSTRING_INDEX(SUBSTRING(option_name, 9), '_', 1) AS UNSIGNED) < %d", (int) floor(time() / 60) - 2));
    }
    return $count === null ? null : (int) $count;
}
add_action('rest_api_init', function () {
    register_rest_route('docslurp/v1', '/search', array('methods' => 'POST', 'permission_callback' => '__return_true', 'callback' => function ($request) {
        $params = $request->get_json_params();
        if (!is_array($params) || array_diff(array_keys($params), array('q')) || !is_string($params['q'] ?? null) || strlen($params['q']) > 2000) { return new WP_Error('invalid_query', 'Send only a query of at most 500 characters.', array('status' => 400)); }
        $query = trim($params['q']);
        $length = preg_match_all('/./us', $query);
        if ($length === false || $length > 500) { return new WP_Error('invalid_query', 'Query is too long or invalid UTF-8.', array('status' => 400)); }
        if ($query === '') { return rest_ensure_response(array('results' => array())); }
        // Bounded public proxy: both client-IP and global fixed-window caps. A hit that cannot be counted is refused,
        // never waved through.
        $config = get_option('docslurp_search_config', array());
        if (!is_array($config)) { $config = array(); }
        $trusted = preg_split('/[\s,]+/', (string) ($config['trusted_proxies'] ?? ''), -1, PREG_SPLIT_NO_EMPTY);
        $client = docslurp_search_client_ip($_SERVER, $trusted);
        $bucket = (string) floor(time() / 60);
        foreach (array($bucket . '_global' => 120, $bucket . '_ip_' . md5($client) => 30) as $name => $limit) {
            $count = docslurp_search_count_hit($name);
            if ($count === null) { return new WP_Error('rate_limit_unavailable', 'Search is unavailable.', array('status' => 503)); }
            if ($count > $limit) { return new WP_Error('rate_limited', 'Please try again in a minute.', array('status' => 429)); }
        }
        if (empty($config['api_key']) || empty($config['api_url'])) { return new WP_Error('not_configured', 'Search is not configured.', array('status' => 503)); }
        $response = wp_safe_remote_post($config['api_url'] . '/v1/search', array('timeout' => 20, 'redirection' => 0, 'headers' => array('Authorization' => 'Bearer ' . $config['api_key'], 'Content-Type' => 'application/json'), 'body' => wp_json_encode(array('q' => $query, 'workspace' => ($config['workspace_id'] ?? '') !== '' ? $config['workspace_id'] : 'default', 'limit' => 6, 'hyde' => false, 'compression' => false, 'queryRewrite' => false, 'queryDecompose' => false, 'stepback' => false, 'selfQuery' => false))));
        if (is_wp_error($response) || wp_remote_retrieve_response_code($response) !== 200) { return new WP_Error('search_unavailable', 'Search is unavailable.', array('status' => 502)); }
        $body = json_decode(wp_remote_retrieve_body($response), true);
        if (!is_array($body) || !is_array($body['results'] ?? null)) { return new WP_Error('search_unavailable', 'Search is unavailable.', array('status' => 502)); }
        $safe = array();
        foreach (array_slice($body['results'], 0, 6) as $hit) { $safe[] = array('text' => $hit['text'] ?? '', 'citation' => array('filename' => $hit['citation']['filename'] ?? '', 'pageNumbers' => $hit['citation']['pageNumbers'] ?? array(), 'canonicalDocumentUri' => $hit['citation']['canonicalDocumentUri'] ?? null)); }
        $result = rest_ensure_response(array('results' => $safe)); $result->header('Cache-Control', 'no-store'); return $result;
    }));
});
add_shortcode('docslurp_search', function () {
    wp_enqueue_script('docslurp-search-widget', plugins_url('search-widget.js', __FILE__), array(), '0.1.0', true);
    return '<docslurp-search-box search-endpoint="' . esc_url(rest_url('docslurp/v1/search')) . '"></docslurp-search-box><noscript>Enable JavaScript to search documents.</noscript>';
});
add_filter('script_loader_tag', function ($tag, $handle) {
    return $handle === 'docslurp-search-widget' ? str_replace('<script ', '<script type="module" ', preg_replace('/ type=["\'][^"\']*["\']/', '', $tag)) : $tag;
}, 10, 2);

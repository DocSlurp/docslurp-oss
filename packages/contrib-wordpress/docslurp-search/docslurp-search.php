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
        return array('api_url' => untrailingslashit($url), 'workspace_id' => sanitize_text_field($value['workspace_id'] ?? ''), 'api_key' => $key);
    }));
});
function docslurp_search_settings() {
    if (!current_user_can('manage_options')) { return; }
    $config = get_option('docslurp_search_config', array());
    echo '<div class="wrap"><h1>DocSlurp Search</h1><p>Use a search-only server key for a workspace whose passages may be public. The shortcode makes search public, without exposing the key. Ingestion stays in DocSlurp.</p><form action="options.php" method="post">';
    settings_fields('docslurp_search');
    foreach (array('api_url' => 'API origin (HTTPS)', 'workspace_id' => 'Workspace slug or ID (optional; blank uses the default workspace)', 'api_key' => 'Search-only server API key') as $name => $label) {
        echo '<p><label>' . esc_html($label) . '<br><input class="regular-text" name="docslurp_search_config[' . esc_attr($name) . ']" type="' . ($name === 'api_key' ? 'password' : 'text') . '" value="' . esc_attr($config[$name] ?? ($name === 'api_url' ? 'https://docslurp.io' : '')) . '" autocomplete="off"></label></p>';
    }
    submit_button(); echo '</form><p>Add <code>[docslurp_search]</code> to a page or post.</p></div>';
}
add_action('rest_api_init', function () {
    register_rest_route('docslurp/v1', '/search', array('methods' => 'POST', 'permission_callback' => '__return_true', 'callback' => function ($request) {
        $params = $request->get_json_params();
        if (!is_array($params) || array_diff(array_keys($params), array('q')) || !is_string($params['q'] ?? null) || strlen($params['q']) > 2000) { return new WP_Error('invalid_query', 'Send only a query of at most 500 characters.', array('status' => 400)); }
        $query = trim($params['q']);
        $length = preg_match_all('/./us', $query);
        if ($length === false || $length > 500) { return new WP_Error('invalid_query', 'Query is too long or invalid UTF-8.', array('status' => 400)); }
        if ($query === '') { return rest_ensure_response(array('results' => array())); }
        // Bounded public proxy: both client-IP and global fixed-window caps.
        $bucket = (string) floor(time() / 60);
        foreach (array('dslp_global_' . $bucket => 120, 'dslp_ip_' . md5(($_SERVER['REMOTE_ADDR'] ?? '') . $bucket) => 30) as $name => $limit) {
            $count = (int) get_transient($name);
            if ($count >= $limit) { return new WP_Error('rate_limited', 'Please try again in a minute.', array('status' => 429)); }
            set_transient($name, $count + 1, 120);
        }
        $config = get_option('docslurp_search_config', array());
        if (empty($config['api_key']) || empty($config['api_url'])) { return new WP_Error('not_configured', 'Search is not configured.', array('status' => 503)); }
        $response = wp_safe_remote_post($config['api_url'] . '/v1/search', array('timeout' => 20, 'redirection' => 0, 'headers' => array('Authorization' => 'Bearer ' . $config['api_key'], 'Content-Type' => 'application/json'), 'body' => wp_json_encode(array('q' => $query, 'workspaceId' => ($config['workspace_id'] ?? '') !== '' ? $config['workspace_id'] : 'default', 'limit' => 6, 'hyde' => false, 'compression' => false, 'queryRewrite' => false, 'queryDecompose' => false, 'stepback' => false, 'selfQuery' => false))));
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

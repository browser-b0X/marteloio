"""Barcode search routing with fake eBay responses and isolated caches."""
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock, patch
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server


class BarcodeSearchTests(unittest.TestCase):
    def test_barcode_format_preserves_leading_zeros_and_rejects_other_input(self):
        for raw, expected in [('0 12345-678905', '012345678905'), ('12345678', '12345678'), ('00123456789012', '00123456789012'), ('   ', '')]:
            self.assertEqual(server.normalize_gtin(raw), expected)
        for value in ['123', '-', '123456789', '１２３４５６７８', '01234567890x', 12345678, '0' * 33]:
            with self.assertRaises(ValueError):
                server.normalize_gtin(value)

    def test_barcode_uses_gtin_without_keyword_parameter(self):
        with patch.object(server, 'app_token_fresh', return_value='fixture-token'), patch.object(server, 'http_get', return_value=(200, '{"itemSummaries":[]}')) as get:
            result = server.browse_search('must not broaden query', 20, gtin='012345678905')
        query = parse_qs(urlsplit(get.call_args.args[0]).query)
        self.assertEqual(query['gtin'], ['012345678905'])
        self.assertNotIn('q', query)
        self.assertNotIn('fieldgroups', query)
        self.assertEqual(result['items'], [])

    def test_endpoint_accepts_barcode_without_product_name(self):
        handler = server.Handler.__new__(server.Handler)
        handler.send_json = Mock()
        with patch.object(server, 'client_id', return_value='fixture-id'), patch.object(server, 'try_search', return_value={'items': []}) as search:
            handler.handle_search({'gtin': ['0 12345-678905']})
        search.assert_called_once_with('', 20, gtin='012345678905')
        handler.send_json.assert_called_once_with({'items': []})

    def test_invalid_barcode_never_falls_back_to_keyword_search(self):
        handler = server.Handler.__new__(server.Handler)
        handler.send_json = Mock()
        with patch.object(server, 'client_id') as credentials, patch.object(server, 'try_search') as search:
            with self.assertRaises(ValueError):
                handler.handle_search({'keywords': ['Camera'], 'gtin': ['invalid']})
        credentials.assert_not_called()
        search.assert_not_called()

    def test_barcode_and_numeric_keyword_searches_have_distinct_cache_entries(self):
        def browse(query, limit, gtin=''):
            return {'items': [{'title': 'Barcode result' if gtin else 'Keyword result'}]}
        with patch.object(server, '_SEARCH_CACHE', {}), patch.object(server, '_SEARCH_PENDING', {}), patch.object(server, 'browse_search', side_effect=browse) as network:
            keyword = server.try_search('012345678905', 20)
            barcode = server.try_search('', 20, gtin='012345678905')
            cached = server.try_search('ignored name', 20, gtin='012345678905')
        self.assertNotEqual(keyword['items'], barcode['items'])
        self.assertEqual(cached['items'], barcode['items'])
        self.assertTrue(cached['cached'])
        self.assertEqual(network.call_count, 2)

    def test_search_preserves_valid_rows_without_unused_aspect_processing(self):
        response = {'itemSummaries': [None, {'title': []}, {'title': '  Good camera  ', 'seller': [], 'itemWebUrl': []}],
                    'refinement': {'aspectDistributions': 'malformed-unused-fixture'}}
        with patch.object(server, 'app_token_fresh', return_value='fixture'), patch.object(server, 'http_get', return_value=(200, json.dumps(response))):
            result = server.browse_search('Camera', 20)
        self.assertEqual(result['items'], [{'title':'Good camera', 'url':'', 'seller_feedback':'', 'seller_pct':''}])
        self.assertEqual(result['aspects'], {})

    def test_malformed_search_response_is_not_an_empty_success(self):
        for response in ([], {'errors': [{'message':'fixture'}]}, {'itemSummaries': {}}, {'itemSummaries': [None, {'title': []}]}):
            with patch.object(server, 'app_token_fresh', return_value='fixture'), patch.object(server, 'http_get', return_value=(200, json.dumps(response))):
                with self.assertRaises(ValueError):
                    server.browse_search('Camera', 20)

    def test_search_bounds_returned_titles_and_item_count(self):
        response = {'itemSummaries': [{'title':'x' * 1000} for _ in range(60)]}
        with patch.object(server, 'app_token_fresh', return_value='fixture'), patch.object(server, 'http_get', return_value=(200, json.dumps(response))):
            result = server.browse_search('Camera', 20)
        self.assertEqual(len(result['items']), 20)
        self.assertTrue(all(len(item['title']) == 300 for item in result['items']))


if __name__ == '__main__':
    unittest.main()

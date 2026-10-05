"""Selected eBay references: fake upstream only, no credentials or providers."""
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server


class ProductReferenceTests(unittest.TestCase):
    def response(self, **changes):
        return dict(itemId='v1|123|0', title='Other seller camera with accessories',
                    itemWebUrl='https://www.ebay.com/itm/123?tracking=x',
                    brand='CameraCo', localizedAspects=[{'name': 'Model', 'value': 'A1'},
                        {'name': 'Condition', 'value': 'New'}, {'name': 'Included accessories', 'value': 'Charger'},
                        {'name': 'Seller warranty', 'value': 'Lifetime'}], **changes)

    def fetch(self, response, status=200):
        with patch.object(server, 'app_token_fresh', return_value='fixture'), patch.object(
                server, 'http_get', return_value=(status, json.dumps(response))) as request:
            result = server.browse_reference('v1|123|0')
        self.assertEqual(request.call_args.args[0], 'https://api.ebay.com/buy/browse/v1/item/v1%7C123%7C0')
        return result

    def test_provenance_and_technical_specs_without_seller_claims(self):
        result = self.fetch(self.response(description='Works perfectly', condition='NEW', shippingOptions=['free']))
        self.assertEqual(result['data'], {'product_name': '', 'key_specs': {'Brand': 'CameraCo', 'Model': 'A1'}})
        self.assertEqual(result['source']['url'], 'https://www.ebay.com/itm/123')
        self.assertEqual(result['source']['item_id'], 'v1|123|0')
        self.assertRegex(result['at'], r'^\d{4}-\d{2}-\d{2}T.*Z$')
        self.assertEqual(result['kind'], 'ebay-listing')

    def test_bad_identity_and_links_rejected(self):
        for changes in ({'itemId': 'v1|999|0'}, {'itemWebUrl': 'https://evil.test/itm/123'},
                        {'itemWebUrl': 'https://www.ebay.com@evil.test/itm/123'}, {'errors': [{}]},
                        {'localizedAspects': {}}, {'itemWebUrl': 'https://www.ebay.com/itm/999'}, {'title': ''}):
            data = self.response(); data.update(changes)
            with self.subTest(changes=changes), self.assertRaises(ValueError): self.fetch(data)

    def test_empty_specs_and_failed_response_not_success(self):
        data = self.response(); data.update(brand='', localizedAspects=[])
        with self.assertRaises(ValueError): self.fetch(data)
        with self.assertRaises(ValueError): self.fetch(self.response(), 503)

    def test_invalid_identifier_never_requests_credentials_or_network(self):
        for value in ('https://evil.test', '../123', 'v1|123|0?x', '', None):
            with patch.object(server, 'app_token_fresh') as token, self.assertRaises(ValueError):
                server.browse_reference(value)
            token.assert_not_called()

    def test_search_keeps_selection_id(self):
        with patch.object(server, 'app_token_fresh', return_value='fixture'), patch.object(server, 'http_get',
                return_value=(200, json.dumps({'itemSummaries': [self.response()]}))):
            result = server.browse_search('camera', 20)
        self.assertEqual(result['items'][0]['item_id'], 'v1|123|0')


if __name__ == '__main__':
    unittest.main()

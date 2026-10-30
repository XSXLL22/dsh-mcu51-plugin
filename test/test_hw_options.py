"""Hardware-option decoding checks; simulated state, never opens a COM port."""
import importlib.util
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from stcgal.options import Stc15Option, Stc89Option

module_spec = importlib.util.spec_from_file_location('isp', Path(__file__).resolve().parents[1] / 'sidecar/isp.py')
isp = importlib.util.module_from_spec(module_spec)
module_spec.loader.exec_module(isp)


class HardwareOptionTests(unittest.TestCase):
    def test_stc15_snapshot_preserves_raw_bytes_and_typed_values(self):
        options = Stc15Option(bytes.fromhex('f7 bb 9f fd ff'))
        options.get_option = lambda name: self.fail('The upstream broken get_option path must not be used')
        result = isp.hardware_options(SimpleNamespace(options=options))
        self.assertTrue(result['ok'], result)
        self.assertTrue(result['readOnly'])
        self.assertEqual(result['rawMsrHex'], 'f7 bb 9f fd ff')
        self.assertIs(result['values']['watchdog_por_enabled'], False)
        self.assertEqual(result['values']['watchdog_prescale'], 256)
        self.assertEqual(result['values']['clock_source'], 'internal')
        self.assertEqual(options.get_msr(), bytes.fromhex('f7 bb 9f fd ff'))

    def test_voltage_encoding_and_unknown_values_are_not_invented(self):
        result = isp.hardware_options(SimpleNamespace(options=Stc15Option(bytes.fromhex('f7 bb 9f fd ff'))))
        self.assertEqual(result['values']['low_voltage_threshold'], 3)
        self.assertEqual(result['fieldMetadata']['low_voltage_threshold']['unit'], 'encoding')
        self.assertIsNone(result['fieldMetadata']['low_voltage_threshold']['volts'])
        self.assertIsNone(result['fieldMetadata']['rstout_por_state']['physicalPin'])
        self.assertEqual(result['values']['cpu_core_voltage'], 'unknown')
        self.assertIn('cpu_core_voltage', result['unknownFields'])

    def test_stc89_integer_register_is_normalized_without_truncation(self):
        result = isp.hardware_options(SimpleNamespace(options=Stc89Option(0xff)))
        self.assertTrue(result['ok'], result)
        self.assertEqual(result['rawMsrHex'], 'ff')
        self.assertIs(result['values']['watchdog_por_enabled'], False)

    def test_official_voltage_maps_are_bound_to_model_and_magic(self):
        for name, magic, expected in [('IAP15F2K61S2', 0xf449, 3.82), ('IAP15L2K61S2', 0xf4c9, 2.42)]:
            options = Stc15Option(bytes.fromhex('f7 bb 9f fd ff'))
            result = isp.hardware_options(SimpleNamespace(options=options, model=SimpleNamespace(name=name), mcu_magic=magic))
            self.assertTrue(result['ok'], result)
            metadata = result['fieldMetadata']['low_voltage_threshold']
            self.assertEqual(result['values']['low_voltage_threshold'], 3)
            self.assertEqual(metadata['volts'], expected)
            self.assertEqual(metadata['mapping'], 'official-static')
            self.assertEqual(metadata['voltageKind'], 'nominal-official-display')
            self.assertFalse(metadata['hardwareValidated'])
            self.assertEqual(result['fieldMetadata']['uart2_pin_mode']['physicalSignal'], 'TXD')
            self.assertTrue(result['fieldMetadata']['uart2_pin_mode']['legacyName'])
        unknown = isp.hardware_options(SimpleNamespace(options=options, model=SimpleNamespace(name='IAP15F2K61S2'), mcu_magic=0xf4c9))
        self.assertIsNone(unknown['fieldMetadata']['low_voltage_threshold']['volts'])

    def test_missing_decoder_is_explicitly_unavailable(self):
        result = isp.hardware_options(SimpleNamespace())
        self.assertFalse(result['available'])
        self.assertEqual(result['support'], 'unknown')

    def test_corrupt_official_metadata_is_a_visible_decode_failure(self):
        target = SimpleNamespace(options=Stc15Option(bytes.fromhex('f7 bb 9f fd ff')),
                                 model=SimpleNamespace(name='IAP15F2K61S2'), mcu_magic=0xf449)
        with patch.object(isp, 'official_option_data', side_effect=ValueError('invalid metadata')):
            result = isp.hardware_options(target)
        self.assertFalse(result['ok'])
        self.assertEqual(result['errors'][0]['field'], 'fieldMetadata')
        self.assertIn('invalid metadata', result['errors'][0]['message'])

    def test_getter_errors_are_exposed_with_field_name(self):
        def broken(): raise ValueError('bad option encoding')
        decoder = SimpleNamespace(get_msr=lambda: b'\x00', options=(('broken_field', broken, None),))
        result = isp.hardware_options(SimpleNamespace(options=decoder))
        self.assertFalse(result['ok'])
        self.assertIsNone(result['values']['broken_field'])
        self.assertEqual(result['errors'][0]['field'], 'broken_field')
        self.assertIn('bad option encoding', result['errors'][0]['message'])

    def test_oversize_integer_register_is_not_silently_truncated(self):
        decoder = SimpleNamespace(get_msr=lambda: 0x100, options=())
        result = isp.hardware_options(SimpleNamespace(options=decoder))
        self.assertFalse(result['ok'])
        self.assertIsNone(result['rawMsrHex'])


if __name__ == '__main__':
    unittest.main(verbosity=2)

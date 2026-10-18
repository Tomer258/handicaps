"""Unit tests for the ops monitor's pure logic: python -I -m unittest discover -s workers/ops-monitor"""

import os
import sys
import unittest
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(__file__))
import monitor as m  # noqa: E402


class Measurements(unittest.TestCase):
    def test_cpu(self):
        a = m.cpu_times("cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 1 2 3")
        b = m.cpu_times("cpu  250 0 250 900 0 0 0 0 0 0\n")
        self.assertAlmostEqual(m.cpu_percent(a, b), 75.0)

    def test_memory(self):
        self.assertAlmostEqual(m.mem_percent("MemTotal: 1000 kB\nMemFree: 100 kB\nMemAvailable: 250 kB\n"), 75.0)

    def test_default_iface_and_bytes(self):
        route = "Iface\tDestination\tGateway\neth0\t0000FEA9\t00000000\nens3\t00000000\t0101A8C0\n"
        self.assertEqual(m.default_iface(route), "ens3")
        dev = ("Inter-|   Receive\n face |bytes packets\n"
               "  ens3: 1000 5 0 0 0 0 0 0 2000 7 0 0 0 0 0 0\n    lo: 9 9 0 0 0 0 0 0 9 9 0 0 0 0 0 0\n")
        self.assertEqual(m.iface_bytes(dev, "ens3"), 3000)
        self.assertIsNone(m.iface_bytes(dev, "wlan0"))

    def test_traffic_survives_reboot_and_month_change(self):
        s = m.add_traffic({}, "2026-10", 1000)
        s = m.add_traffic(s, "2026-10", 1500)
        self.assertEqual(s["used"], 500)
        s = m.add_traffic(s, "2026-10", 200)  # counter reset after a reboot
        self.assertEqual(s["used"], 700)
        s = m.add_traffic(s, "2026-11", 300)
        self.assertEqual(s["used"], 0)

    def test_der_not_after(self):
        validity = b"\x30\x1e\x17\x0d" + b"260101000000Z" + b"\x17\x0d" + b"270215123000Z"
        der = b"\x30\x82\x01\x00\x02\x01\x05" + validity + b"\x30\x00"
        expected = datetime(2027, 2, 15, 12, 30, tzinfo=timezone.utc).timestamp()
        self.assertEqual(m.der_not_after(der), expected)
        with self.assertRaises(ValueError):
            m.der_not_after(b"\x30\x00")


class Alerts(unittest.TestCase):
    def test_alert_remind_resolve(self):
        alerts = {}
        self.assertIsNone(m.evaluate(alerts, "disk", False, "50%", 0, 3600))
        self.assertTrue(m.evaluate(alerts, "disk", True, "85%", 10, 3600).startswith("ALERT disk"))
        self.assertIsNone(m.evaluate(alerts, "disk", True, "86%", 100, 3600))
        self.assertTrue(m.evaluate(alerts, "disk", True, "87%", 3700, 3600).startswith("STILL BAD disk"))
        self.assertTrue(m.evaluate(alerts, "disk", False, "60%", 3800, 3600).startswith("RESOLVED disk"))
        self.assertIsNone(m.evaluate(alerts, "disk", False, "60%", 3900, 3600))

    def test_failing_for(self):
        st = {}
        self.assertEqual(m.failing_for(st, "api", True, 0), 0.0)
        self.assertEqual(m.failing_for(st, "api", False, 60), 0.0)
        self.assertEqual(m.failing_for(st, "api", False, 240), 3.0)
        self.assertEqual(m.failing_for(st, "api", True, 300), 0.0)
        self.assertNotIn("api", st)


if __name__ == "__main__":
    unittest.main()
